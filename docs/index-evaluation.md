# Index Evaluation

## General

### Data

All data is synthetic

- 3 clinics and 90 professionals
- 300,000 appointments, including 96,009 reserved appointments
- 12,069 blocks, including blocks that begin before the requested dates
- 900 weekly schedule intervals
- 177 professional-service associations

Appointments include all five states and past and future dates. The requested dates run from November 23 to November 29, 2026, using a 30-minute service

### Measurements

Every case has three warm-up runs and ten measured runs. Tables show the median execution time in milliseconds

The comparisons use the same data, SQL, parameters and clinic access rules in PostgreSQL 18.6. Individual candidates are tested separately, then selected combinations are tested together. Existing primary and unique indexes stay in place, and PostgreSQL chooses the plans

Plans use EXPLAIN (ANALYZE, BUFFERS, SETTINGS, TIMING OFF, FORMAT JSON). Each result links to its first measured plan and ten samples. Every read returns the same rows with every applicable index configuration

The text below shows selected branches from those JSON plans, with each case identified above its plan. IDs and omitted branches use `...` Actual rows are output rows per loop, before any parent filter. Node times are absent because TIMING OFF is used

Sizes use pg_relation_size after index creation and cover all three clinics. One KiB is 1,024 bytes

Write measurements cover the SQL operations listed below. Each operation is rolled back after measurement. Replacing a week measures the combined execution time of its delete and insert

Excluded: HTTP, authentication, slot calculation, Redis, other business checks, transaction commit and load testing. The measured reads reuse data already in PostgreSQL memory

### Queries

#### Read service and clinic settings

Given a clinic and a service, returns the service ID, required specialty and duration, along with the clinic time zone and availability version

Parameters: clinic ID, service ID

```sql
SELECT service.service_id AS "serviceId", service.specialty_id AS "specialtyId",
	service.duration_minutes AS "durationMinutes", clinic.time_zone AS "timeZone", availability.version::text AS version
FROM public.clinics AS clinic
JOIN public.services AS service USING (clinic_id)
LEFT JOIN public.clinic_availability_versions AS availability USING (clinic_id)
WHERE clinic.clinic_id = $1::uuid AND service.service_id = $2::uuid
```

#### Check professionals for a service

Returns professional IDs and whether they can provide the service. With a professional ID, it checks that professional. Without one, it returns all professionals who qualify

Parameters: clinic ID, service ID, required specialty ID, professional ID or NULL

```sql
WITH candidates AS (
	SELECT professional.professional_id,
		COALESCE(association.is_active AND professional.specialty_id = $3::uuid
			AND account.is_active AND account.role = 'healthcare_professional', false) AS eligible
	FROM public.professionals AS professional
	JOIN public.users AS account USING (clinic_id, user_id)
	LEFT JOIN public.professional_services AS association
		ON association.clinic_id = professional.clinic_id AND association.professional_id = professional.professional_id
		AND association.service_id = $2::uuid
	WHERE professional.clinic_id = $1::uuid AND ($4::uuid IS NULL OR professional.professional_id = $4)
)
SELECT professional_id AS "professionalId", eligible FROM candidates
WHERE $4::uuid IS NOT NULL OR eligible ORDER BY professional_id
```

#### Read weekly professional schedules

Returns each professional ID, weekday and the start and end minutes of every weekly schedule interval. The query receives professional IDs and reads their complete weeks

Parameters: clinic ID, list of professional IDs

```sql
SELECT professional_id AS "professionalId", weekday, start_minute AS "startMinute", end_minute AS "endMinute"
FROM public.professional_schedules WHERE clinic_id = $1::uuid AND professional_id = ANY($2::uuid[])
```

#### Read reserved appointments and blocks

Returns professional IDs and start and end timestamps for reserved appointments and blocks that overlap the supplied time windows

Parameters: clinic ID, list of professional IDs, JSON windows containing professionalId, start and end in Unix milliseconds

Windows cover the requested dates and allow for the service duration

```sql
WITH search_windows AS (
	SELECT span."professionalId" AS professional_id,
		to_timestamp(span.start/1000.0) AS start_at, to_timestamp(span."end"/1000.0) AS end_at
	FROM jsonb_to_recordset($3::jsonb) AS span("professionalId" uuid, start bigint, "end" bigint)
)
SELECT appointment.professional_id AS "professionalId", appointment.start_at AS "startAt", appointment.end_at AS "endAt"
FROM public.appointments AS appointment
WHERE appointment.clinic_id = $1::uuid AND appointment.professional_id = ANY($2::uuid[])
	AND appointment.state = 'reserved'
	AND EXISTS (SELECT 1 FROM search_windows AS search_window
		WHERE search_window.professional_id = appointment.professional_id
			AND appointment.start_at < search_window.end_at AND appointment.end_at > search_window.start_at)
UNION ALL
SELECT block.professional_id AS "professionalId", block.start_at AS "startAt", block.end_at AS "endAt"
FROM public.professional_blocks AS block
WHERE block.clinic_id = $1::uuid AND block.professional_id = ANY($2::uuid[])
	AND EXISTS (SELECT 1 FROM search_windows AS search_window
		WHERE search_window.professional_id = block.professional_id
			AND block.start_at < search_window.end_at AND block.end_at > search_window.start_at)
```

### Write queries

Each operation affects one row, except the weekly schedule replacement, which deletes and inserts ten intervals. Appointment insertion uses a free future slot. Cancellation sets a reason and the cancelling user. All values come from the same synthetic fixture

#### Insert one reserved appointment

Parameters: clinic ID, professional ID, patient ID, service ID, start, end and previous appointment ID or NULL

```sql
INSERT INTO public.appointments (clinic_id, professional_id, patient_id, service_id, start_at, end_at, previous_appointment_id)
SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz, $6::timestamptz, $7::uuid
WHERE $5::timestamptz > clock_timestamp() AND EXTRACT(SECOND FROM $5::timestamptz AT TIME ZONE 'UTC') = 0
RETURNING appointment_id AS "appointmentId"
```

#### Cancel one reserved appointment

Parameters: appointment ID, cancellation reason and cancelling user ID

```sql
UPDATE public.appointments
SET state = 'cancelled', cancellation_reason = $2::text, cancelled_by_user_id = $3::uuid
WHERE appointment_id = $1::uuid
```

#### Insert one block

Parameters: clinic ID, professional ID, start and end

```sql
INSERT INTO public.professional_blocks (clinic_id, professional_id, start_at, end_at)
VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz)
RETURNING professional_block_id AS "professionalBlockId"
```

#### Replace ten weekly schedule intervals

Parameters: professional ID for deletion, then clinic ID, professional ID and JSON intervals for insertion

```sql
DELETE FROM public.professional_schedules
WHERE professional_id = $1::uuid
```

```sql
INSERT INTO public.professional_schedules (clinic_id, professional_id, weekday, start_minute, end_minute)
SELECT $1::uuid, $2::uuid, weekday, "startMinute", "endMinute"
FROM jsonb_to_recordset($3::jsonb) AS interval(weekday smallint, "startMinute" smallint, "endMinute" smallint)
```

#### Deactivate one professional-service association

Parameters: clinic ID, professional ID, service ID and false

```sql
UPDATE public.professional_services
SET is_active = $4::boolean
WHERE clinic_id = $1::uuid AND professional_id = $2::uuid AND service_id = $3::uuid
RETURNING professional_id AS "professionalId", service_id AS "serviceId", is_active AS "isActive"
```

## Existing indexes

These measurements use only the indexes created by the migrations

### Read service and clinic settings

Median time: **0.041 ms** [Plan](../performance/indexes/existing-indexes/metadata-clinic-service-plan.json) [Samples](../performance/indexes/existing-indexes/metadata-clinic-service-samples.csv)

[Plan](../performance/indexes/existing-indexes/metadata-clinic-service-plan.json)

```text
Seq Scan on clinics (actual rows=1 loops=1)
  Rows Removed by Filter: 2

Seq Scan on services (actual rows=1 loops=1)
  Rows Removed by Filter: 8

Seq Scan on clinic_availability_versions (actual rows=1 loops=1)
  Rows Removed by Filter: 0
```

Plan: scans all 3 clinic rows and all 9 service rows. The availability version scan stops after its first match. The query returns one row, and these tables are small

### Check professionals for a service

| Professional ID filter | Median time |
| --- | ---: |
| A specific ID | **0.073 ms** [Plan](../performance/indexes/existing-indexes/professionals-professional-plan.json) [Samples](../performance/indexes/existing-indexes/professionals-professional-samples.csv) |
| NULL | **0.135 ms** [Plan](../performance/indexes/existing-indexes/professionals-service-plan.json) [Samples](../performance/indexes/existing-indexes/professionals-service-samples.csv) |

[Plan, one professional](../performance/indexes/existing-indexes/professionals-professional-plan.json)

```text
Seq Scan on users (actual rows=32 loops=1)
  Rows Removed by Filter: 65

Seq Scan on professionals (actual rows=1 loops=1)
  Rows Removed by Filter: 89

Seq Scan on professional_services (actual rows=1 loops=1)
  Rows Removed by Filter: 38
```

Plan: both cases scan all 90 professional rows and all 97 user rows. The association scan reads 39 rows before finding the specific professional's match and all 177 rows without an ID. Requesting one professional still requires scanning every professional and user row

### Read weekly professional schedules

| Professional IDs | Median time |
| --- | ---: |
| List with one ID | **0.082 ms** [Plan](../performance/indexes/existing-indexes/schedules-professional-plan.json) [Samples](../performance/indexes/existing-indexes/schedules-professional-samples.csv) |
| List with multiple IDs | **0.248 ms** [Plan](../performance/indexes/existing-indexes/schedules-service-plan.json) [Samples](../performance/indexes/existing-indexes/schedules-service-samples.csv) |

[Plan, one professional](../performance/indexes/existing-indexes/schedules-professional-plan.json)

```text
Seq Scan on professional_schedules (actual rows=10 loops=1)
  Rows Removed by Filter: 890
```

Plan: scans all 900 schedule rows. One ID keeps 10 rows and discards 890. Multiple IDs keep 290 and discard 610. The table scan stays the same size in both cases

### Read reserved appointments and blocks

| Professional IDs | Dates used to build windows | Median time |
| --- | --- | ---: |
| List with one ID | One date | **20.465 ms** [Plan](../performance/indexes/existing-indexes/occupation-professional-day-plan.json) [Samples](../performance/indexes/existing-indexes/occupation-professional-day-samples.csv) |
| List with one ID | Seven consecutive dates | **25.259 ms** [Plan](../performance/indexes/existing-indexes/occupation-professional-week-plan.json) [Samples](../performance/indexes/existing-indexes/occupation-professional-week-samples.csv) |
| List with multiple IDs | One date | **62.618 ms** [Plan](../performance/indexes/existing-indexes/occupation-service-day-plan.json) [Samples](../performance/indexes/existing-indexes/occupation-service-day-samples.csv) |
| List with multiple IDs | Seven consecutive dates | **64.576 ms** [Plan](../performance/indexes/existing-indexes/occupation-service-week-plan.json) [Samples](../performance/indexes/existing-indexes/occupation-service-week-samples.csv) |

[Plan, one professional and one date](../performance/indexes/existing-indexes/occupation-professional-day-plan.json)

```text
Bitmap Index Scan using appointments_previous_key (actual rows=100000 loops=1)
  Index Cond: (clinic_id = '...'::uuid)

Seq Scan on professional_blocks (actual rows=134 loops=1)
  Rows Removed by Filter: 11935
```

Plan: appointments_previous_key narrows 300,000 appointments to 100,000 clinic candidates. PostgreSQL then checks professional, state and time overlap. Blocks still require scanning all 12,069 rows. The four cases return 11, 54, 345 and 1,592 occupied intervals, respectively, so most rows examined are discarded

## Reserved appointment index comparison

### Index with end time

```sql
CREATE INDEX appointments_reserved_end_idx
ON public.appointments (clinic_id, professional_id, end_at)
WHERE state = 'reserved'
```

#### Read reserved appointments and blocks

| Professional IDs | Dates used to build windows | Existing indexes | With this index |
| --- | --- | ---: | ---: |
| List with one ID | One date | **20.465 ms** [Plan](../performance/indexes/existing-indexes/occupation-professional-day-plan.json) [Samples](../performance/indexes/existing-indexes/occupation-professional-day-samples.csv) | **1.690 ms** [Plan](../performance/indexes/appointments-end/occupation-professional-day-plan.json) [Samples](../performance/indexes/appointments-end/occupation-professional-day-samples.csv) |
| List with one ID | Seven consecutive dates | **25.259 ms** [Plan](../performance/indexes/existing-indexes/occupation-professional-week-plan.json) [Samples](../performance/indexes/existing-indexes/occupation-professional-week-samples.csv) | **1.528 ms** [Plan](../performance/indexes/appointments-end/occupation-professional-week-plan.json) [Samples](../performance/indexes/appointments-end/occupation-professional-week-samples.csv) |
| List with multiple IDs | One date | **62.618 ms** [Plan](../performance/indexes/existing-indexes/occupation-service-day-plan.json) [Samples](../performance/indexes/existing-indexes/occupation-service-day-samples.csv) | **25.700 ms** [Plan](../performance/indexes/appointments-end/occupation-service-day-plan.json) [Samples](../performance/indexes/appointments-end/occupation-service-day-samples.csv) |
| List with multiple IDs | Seven consecutive dates | **64.576 ms** [Plan](../performance/indexes/existing-indexes/occupation-service-week-plan.json) [Samples](../performance/indexes/existing-indexes/occupation-service-week-samples.csv) | **28.745 ms** [Plan](../performance/indexes/appointments-end/occupation-service-week-plan.json) [Samples](../performance/indexes/appointments-end/occupation-service-week-samples.csv) |

[Plan, one professional and one date](../performance/indexes/appointments-end/occupation-professional-day-plan.json)

```text
Hash Semi Join (actual rows=10 loops=1)
  Join Filter: ((appointment.start_at < search_window.end_at) AND (appointment.end_at > search_window.start_at))
  Rows Removed by Join Filter: 1070
  ->  Index Scan using appointments_reserved_end_idx on appointments (actual rows=1080 loops=1)
        Index Cond: ((clinic_id = '...'::uuid) AND (professional_id = ANY ('{...}'::uuid[])))
        Rows Removed by Filter: 0
  ...
```

Plan: reads 1,080 reserved appointments for one professional and 31,325 for multiple IDs, instead of checking about 100,000 clinic appointments. It uses an index scan for one ID and a bitmap scan for multiple IDs. The index conditions do not use end_at, so time overlap is checked afterward. All four cases still scan all 12,069 block rows

#### Index size

**5,560 KiB**

### Index with start time

```sql
CREATE INDEX appointments_reserved_start_idx
ON public.appointments (clinic_id, professional_id, start_at)
WHERE state = 'reserved'
```

#### Read reserved appointments and blocks

| Professional IDs | Dates used to build windows | Existing indexes | With this index |
| --- | --- | ---: | ---: |
| List with one ID | One date | **20.465 ms** [Plan](../performance/indexes/existing-indexes/occupation-professional-day-plan.json) [Samples](../performance/indexes/existing-indexes/occupation-professional-day-samples.csv) | **1.470 ms** [Plan](../performance/indexes/appointments-start/occupation-professional-day-plan.json) [Samples](../performance/indexes/appointments-start/occupation-professional-day-samples.csv) |
| List with one ID | Seven consecutive dates | **25.259 ms** [Plan](../performance/indexes/existing-indexes/occupation-professional-week-plan.json) [Samples](../performance/indexes/existing-indexes/occupation-professional-week-samples.csv) | **2.540 ms** [Plan](../performance/indexes/appointments-start/occupation-professional-week-plan.json) [Samples](../performance/indexes/appointments-start/occupation-professional-week-samples.csv) |
| List with multiple IDs | One date | **62.618 ms** [Plan](../performance/indexes/existing-indexes/occupation-service-day-plan.json) [Samples](../performance/indexes/existing-indexes/occupation-service-day-samples.csv) | **26.897 ms** [Plan](../performance/indexes/appointments-start/occupation-service-day-plan.json) [Samples](../performance/indexes/appointments-start/occupation-service-day-samples.csv) |
| List with multiple IDs | Seven consecutive dates | **64.576 ms** [Plan](../performance/indexes/existing-indexes/occupation-service-week-plan.json) [Samples](../performance/indexes/existing-indexes/occupation-service-week-samples.csv) | **26.574 ms** [Plan](../performance/indexes/appointments-start/occupation-service-week-plan.json) [Samples](../performance/indexes/appointments-start/occupation-service-week-samples.csv) |

[Plan, one professional and one date](../performance/indexes/appointments-start/occupation-professional-day-plan.json)

```text
Hash Semi Join (actual rows=10 loops=1)
  Join Filter: ((appointment.start_at < search_window.end_at) AND (appointment.end_at > search_window.start_at))
  Rows Removed by Join Filter: 1070
  ->  Index Scan using appointments_reserved_start_idx on appointments (actual rows=1080 loops=1)
        Index Cond: ((clinic_id = '...'::uuid) AND (professional_id = ANY ('{...}'::uuid[])))
        Rows Removed by Filter: 0
  ...
```

Plan: reads 1,080 reserved appointments for one professional and 31,325 for multiple IDs, instead of checking about 100,000 clinic appointments. It uses an index scan for one ID and a bitmap scan for multiple IDs. The index conditions do not use start_at, so time overlap is checked afterward. All four cases still scan all 12,069 block rows

#### Index size

**5,560 KiB**

### Index without a time column

```sql
CREATE INDEX appointments_reserved_idx
ON public.appointments (clinic_id, professional_id)
WHERE state = 'reserved'
```

#### Read reserved appointments and blocks

| Professional IDs | Dates used to build windows | Existing indexes | With this index |
| --- | --- | ---: | ---: |
| List with one ID | One date | **20.465 ms** [Plan](../performance/indexes/existing-indexes/occupation-professional-day-plan.json) [Samples](../performance/indexes/existing-indexes/occupation-professional-day-samples.csv) | **1.652 ms** [Plan](../performance/indexes/appointments-professional/occupation-professional-day-plan.json) [Samples](../performance/indexes/appointments-professional/occupation-professional-day-samples.csv) |
| List with one ID | Seven consecutive dates | **25.259 ms** [Plan](../performance/indexes/existing-indexes/occupation-professional-week-plan.json) [Samples](../performance/indexes/existing-indexes/occupation-professional-week-samples.csv) | **1.766 ms** [Plan](../performance/indexes/appointments-professional/occupation-professional-week-plan.json) [Samples](../performance/indexes/appointments-professional/occupation-professional-week-samples.csv) |
| List with multiple IDs | One date | **62.618 ms** [Plan](../performance/indexes/existing-indexes/occupation-service-day-plan.json) [Samples](../performance/indexes/existing-indexes/occupation-service-day-samples.csv) | **25.388 ms** [Plan](../performance/indexes/appointments-professional/occupation-service-day-plan.json) [Samples](../performance/indexes/appointments-professional/occupation-service-day-samples.csv) |
| List with multiple IDs | Seven consecutive dates | **64.576 ms** [Plan](../performance/indexes/existing-indexes/occupation-service-week-plan.json) [Samples](../performance/indexes/existing-indexes/occupation-service-week-samples.csv) | **34.753 ms** [Plan](../performance/indexes/appointments-professional/occupation-service-week-plan.json) [Samples](../performance/indexes/appointments-professional/occupation-service-week-samples.csv) |

[Plan, one professional and one date](../performance/indexes/appointments-professional/occupation-professional-day-plan.json)

```text
Hash Semi Join (actual rows=10 loops=1)
  Join Filter: ((appointment.start_at < search_window.end_at) AND (appointment.end_at > search_window.start_at))
  Rows Removed by Join Filter: 1070
  ->  Index Scan using appointments_reserved_idx on appointments (actual rows=1080 loops=1)
        Index Cond: ((clinic_id = '...'::uuid) AND (professional_id = ANY ('{...}'::uuid[])))
        Rows Removed by Filter: 0
  ...
```

Plan: reads 1,080 reserved appointments for one professional and 31,325 for multiple IDs, instead of checking about 100,000 clinic appointments. It uses an index scan for one ID and a bitmap scan for multiple IDs. The index filters by clinic and professional, then time overlap is checked afterward. All four cases still scan all 12,069 block rows

#### Index size

**728 KiB**

### Comparison

All three indexes reduce appointment candidates to the same 1,080 or 31,325 rows. The end-time and start-time scans do not use their time columns to narrow the search. Removing the time column saves about 87% of the index space. The fastest variant changes between cases, so the combined measurements below also matter

## Professional block index comparison

### Index with end time

```sql
CREATE INDEX professional_blocks_end_idx
ON public.professional_blocks (clinic_id, professional_id, end_at)
```

#### Read reserved appointments and blocks

| Professional IDs | Dates used to build windows | Existing indexes | With this index |
| --- | --- | ---: | ---: |
| List with one ID | One date | **20.465 ms** [Plan](../performance/indexes/existing-indexes/occupation-professional-day-plan.json) [Samples](../performance/indexes/existing-indexes/occupation-professional-day-samples.csv) | **15.809 ms** [Plan](../performance/indexes/blocks-end/occupation-professional-day-plan.json) [Samples](../performance/indexes/blocks-end/occupation-professional-day-samples.csv) |
| List with one ID | Seven consecutive dates | **25.259 ms** [Plan](../performance/indexes/existing-indexes/occupation-professional-week-plan.json) [Samples](../performance/indexes/existing-indexes/occupation-professional-week-samples.csv) | **13.261 ms** [Plan](../performance/indexes/blocks-end/occupation-professional-week-plan.json) [Samples](../performance/indexes/blocks-end/occupation-professional-week-samples.csv) |
| List with multiple IDs | One date | **62.618 ms** [Plan](../performance/indexes/existing-indexes/occupation-service-day-plan.json) [Samples](../performance/indexes/existing-indexes/occupation-service-day-samples.csv) | **59.088 ms** [Plan](../performance/indexes/blocks-end/occupation-service-day-plan.json) [Samples](../performance/indexes/blocks-end/occupation-service-day-samples.csv) |
| List with multiple IDs | Seven consecutive dates | **64.576 ms** [Plan](../performance/indexes/existing-indexes/occupation-service-week-plan.json) [Samples](../performance/indexes/existing-indexes/occupation-service-week-samples.csv) | **61.899 ms** [Plan](../performance/indexes/blocks-end/occupation-service-week-plan.json) [Samples](../performance/indexes/blocks-end/occupation-service-week-samples.csv) |

[Plan, one professional and one date](../performance/indexes/blocks-end/occupation-professional-day-plan.json)

```text
Hash Semi Join (actual rows=1 loops=1)
  Join Filter: ((block.start_at < search_window_1.end_at) AND (block.end_at > search_window_1.start_at))
  Rows Removed by Join Filter: 133
  ->  Bitmap Heap Scan on professional_blocks (actual rows=134 loops=1)
        Rows Removed by Filter: 0
        ->  Bitmap Index Scan using professional_blocks_end_idx (actual rows=134 loops=1)
              Index Cond: ((clinic_id = '...'::uuid) AND (professional_id = ANY ('{...}'::uuid[])))
  ...
```

Plan: uses bitmap scans to read 134 blocks for one professional and 3,888 for multiple IDs, instead of scanning all 12,069 block rows. The index conditions do not use end_at, so time overlap is checked afterward. The appointment branch still uses the existing clinic index, so this change only reduces the block scan

#### Index size

**712 KiB**

### Index with start time

```sql
CREATE INDEX professional_blocks_start_idx
ON public.professional_blocks (clinic_id, professional_id, start_at)
```

#### Read reserved appointments and blocks

| Professional IDs | Dates used to build windows | Existing indexes | With this index |
| --- | --- | ---: | ---: |
| List with one ID | One date | **20.465 ms** [Plan](../performance/indexes/existing-indexes/occupation-professional-day-plan.json) [Samples](../performance/indexes/existing-indexes/occupation-professional-day-samples.csv) | **13.104 ms** [Plan](../performance/indexes/blocks-start/occupation-professional-day-plan.json) [Samples](../performance/indexes/blocks-start/occupation-professional-day-samples.csv) |
| List with one ID | Seven consecutive dates | **25.259 ms** [Plan](../performance/indexes/existing-indexes/occupation-professional-week-plan.json) [Samples](../performance/indexes/existing-indexes/occupation-professional-week-samples.csv) | **13.616 ms** [Plan](../performance/indexes/blocks-start/occupation-professional-week-plan.json) [Samples](../performance/indexes/blocks-start/occupation-professional-week-samples.csv) |
| List with multiple IDs | One date | **62.618 ms** [Plan](../performance/indexes/existing-indexes/occupation-service-day-plan.json) [Samples](../performance/indexes/existing-indexes/occupation-service-day-samples.csv) | **73.043 ms** [Plan](../performance/indexes/blocks-start/occupation-service-day-plan.json) [Samples](../performance/indexes/blocks-start/occupation-service-day-samples.csv) |
| List with multiple IDs | Seven consecutive dates | **64.576 ms** [Plan](../performance/indexes/existing-indexes/occupation-service-week-plan.json) [Samples](../performance/indexes/existing-indexes/occupation-service-week-samples.csv) | **65.629 ms** [Plan](../performance/indexes/blocks-start/occupation-service-week-plan.json) [Samples](../performance/indexes/blocks-start/occupation-service-week-samples.csv) |

[Plan, one professional and one date](../performance/indexes/blocks-start/occupation-professional-day-plan.json)

```text
Hash Semi Join (actual rows=1 loops=1)
  Join Filter: ((block.start_at < search_window_1.end_at) AND (block.end_at > search_window_1.start_at))
  Rows Removed by Join Filter: 133
  ->  Bitmap Heap Scan on professional_blocks (actual rows=134 loops=1)
        Rows Removed by Filter: 0
        ->  Bitmap Index Scan using professional_blocks_start_idx (actual rows=134 loops=1)
              Index Cond: ((clinic_id = '...'::uuid) AND (professional_id = ANY ('{...}'::uuid[])))
  ...
```

Plan: uses bitmap scans to read 134 blocks for one professional and 3,888 for multiple IDs, instead of scanning all 12,069 block rows. The index conditions do not use start_at, so time overlap is checked afterward. The appointment branch still uses the existing clinic index, so this change only reduces the block scan

#### Index size

**712 KiB**

### Index without a time column

```sql
CREATE INDEX professional_blocks_idx
ON public.professional_blocks (clinic_id, professional_id)
```

#### Read reserved appointments and blocks

| Professional IDs | Dates used to build windows | Existing indexes | With this index |
| --- | --- | ---: | ---: |
| List with one ID | One date | **20.465 ms** [Plan](../performance/indexes/existing-indexes/occupation-professional-day-plan.json) [Samples](../performance/indexes/existing-indexes/occupation-professional-day-samples.csv) | **15.038 ms** [Plan](../performance/indexes/blocks-professional/occupation-professional-day-plan.json) [Samples](../performance/indexes/blocks-professional/occupation-professional-day-samples.csv) |
| List with one ID | Seven consecutive dates | **25.259 ms** [Plan](../performance/indexes/existing-indexes/occupation-professional-week-plan.json) [Samples](../performance/indexes/existing-indexes/occupation-professional-week-samples.csv) | **14.122 ms** [Plan](../performance/indexes/blocks-professional/occupation-professional-week-plan.json) [Samples](../performance/indexes/blocks-professional/occupation-professional-week-samples.csv) |
| List with multiple IDs | One date | **62.618 ms** [Plan](../performance/indexes/existing-indexes/occupation-service-day-plan.json) [Samples](../performance/indexes/existing-indexes/occupation-service-day-samples.csv) | **63.666 ms** [Plan](../performance/indexes/blocks-professional/occupation-service-day-plan.json) [Samples](../performance/indexes/blocks-professional/occupation-service-day-samples.csv) |
| List with multiple IDs | Seven consecutive dates | **64.576 ms** [Plan](../performance/indexes/existing-indexes/occupation-service-week-plan.json) [Samples](../performance/indexes/existing-indexes/occupation-service-week-samples.csv) | **66.567 ms** [Plan](../performance/indexes/blocks-professional/occupation-service-week-plan.json) [Samples](../performance/indexes/blocks-professional/occupation-service-week-samples.csv) |

[Plan, one professional and one date](../performance/indexes/blocks-professional/occupation-professional-day-plan.json)

```text
Hash Semi Join (actual rows=1 loops=1)
  Join Filter: ((block.start_at < search_window_1.end_at) AND (block.end_at > search_window_1.start_at))
  Rows Removed by Join Filter: 133
  ->  Bitmap Heap Scan on professional_blocks (actual rows=134 loops=1)
        Rows Removed by Filter: 0
        ->  Bitmap Index Scan using professional_blocks_idx (actual rows=134 loops=1)
              Index Cond: ((clinic_id = '...'::uuid) AND (professional_id = ANY ('{...}'::uuid[])))
  ...
```

Plan: uses bitmap scans to read 134 blocks for one professional and 3,888 for multiple IDs, instead of scanning all 12,069 block rows. The index filters by clinic and professional, then time overlap is checked afterward. The appointment branch still uses the existing clinic index, so this change only reduces the block scan

#### Index size

**104 KiB**

### Comparison

All three indexes read the same block candidates. The end-time and start-time scans do not use their time columns to narrow the search. Removing the time column saves about 85% of the index space. The appointment branch still reads about 100,000 candidates, and some cases are slower in this run

## Weekly schedule index comparison

### Index with clinic and professional IDs

```sql
CREATE INDEX professional_schedules_idx
ON public.professional_schedules (clinic_id, professional_id)
```

#### Read weekly professional schedules

| Professional IDs | Existing indexes | With this index |
| --- | ---: | ---: |
| List with one ID | **0.082 ms** [Plan](../performance/indexes/existing-indexes/schedules-professional-plan.json) [Samples](../performance/indexes/existing-indexes/schedules-professional-samples.csv) | **0.037 ms** [Plan](../performance/indexes/schedules/schedules-professional-plan.json) [Samples](../performance/indexes/schedules/schedules-professional-samples.csv) |
| List with multiple IDs | **0.248 ms** [Plan](../performance/indexes/existing-indexes/schedules-service-plan.json) [Samples](../performance/indexes/existing-indexes/schedules-service-samples.csv) | **0.170 ms** [Plan](../performance/indexes/schedules/schedules-service-plan.json) [Samples](../performance/indexes/schedules/schedules-service-samples.csv) |

[Plan, one professional](../performance/indexes/schedules/schedules-professional-plan.json)

```text
Bitmap Heap Scan on professional_schedules (actual rows=10 loops=1)
  Rows Removed by Filter: 0
  ->  Bitmap Index Scan using professional_schedules_idx (actual rows=10 loops=1)
        Index Cond: ((clinic_id = '...'::uuid) AND (professional_id = ANY ('{...}'::uuid[])))
```

Plan: bitmap scans read the 10 or 290 matching schedule rows instead of scanning all 900. There are no rows removed by the scan filter. The index avoids reading unrelated schedules, with a small absolute time saving in these individual tests

#### Index size

**32 KiB**

## Professional-service index comparison

### Index for active associations

```sql
CREATE INDEX professional_services_active_idx
ON public.professional_services (clinic_id, service_id, professional_id)
WHERE is_active
```

#### Check professionals for a service

| Professional ID filter | Existing indexes | With this index |
| --- | ---: | ---: |
| A specific ID | **0.073 ms** [Plan](../performance/indexes/existing-indexes/professionals-professional-plan.json) [Samples](../performance/indexes/existing-indexes/professionals-professional-samples.csv) | **0.155 ms** [Plan](../performance/indexes/associations/professionals-professional-plan.json) [Samples](../performance/indexes/associations/professionals-professional-samples.csv) |
| NULL | **0.135 ms** [Plan](../performance/indexes/existing-indexes/professionals-service-plan.json) [Samples](../performance/indexes/existing-indexes/professionals-service-samples.csv) | **0.186 ms** [Plan](../performance/indexes/associations/professionals-service-plan.json) [Samples](../performance/indexes/associations/professionals-service-samples.csv) |

[Plan, one professional](../performance/indexes/associations/professionals-professional-plan.json)

```text
Seq Scan on users (actual rows=32 loops=1)
  Rows Removed by Filter: 65

Seq Scan on professionals (actual rows=1 loops=1)
  Rows Removed by Filter: 89

Seq Scan on professional_services (actual rows=1 loops=1)
  Rows Removed by Filter: 38
```

Plan: PostgreSQL does not use the new index. It keeps the same professional, user and association scans as with the existing indexes, including the 39-row association scan for one ID and the full 177-row scan without an ID. These plans show no reduction in work from this candidate

#### Index size

**32 KiB**

## Combined index comparison

### Index sets

| Set | Appointment index | Block index | Other indexes |
| --- | --- | --- | --- |
| End-time set | With end time | With end time | Schedules and active associations |
| Start-time set | With start time | Without a time column | Schedules |
| Smallest set | Without a time column | Without a time column | Schedules |

### Read service and clinic settings

| Existing indexes | End-time set | Start-time set | Smallest set |
| ---: | ---: | ---: | ---: |
| **0.041 ms** [Plan](../performance/indexes/existing-indexes/metadata-clinic-service-plan.json) [Samples](../performance/indexes/existing-indexes/metadata-clinic-service-samples.csv) | **0.043 ms** [Plan](../performance/indexes/combined-end/metadata-clinic-service-plan.json) [Samples](../performance/indexes/combined-end/metadata-clinic-service-samples.csv) | **0.048 ms** [Plan](../performance/indexes/combined-start/metadata-clinic-service-plan.json) [Samples](../performance/indexes/combined-start/metadata-clinic-service-samples.csv) | **0.035 ms** [Plan](../performance/indexes/combined-professional/metadata-clinic-service-plan.json) [Samples](../performance/indexes/combined-professional/metadata-clinic-service-samples.csv) |

[Plan, smallest set](../performance/indexes/combined-professional/metadata-clinic-service-plan.json)

```text
Seq Scan on clinics (actual rows=1 loops=1)
  Rows Removed by Filter: 2

Seq Scan on services (actual rows=1 loops=1)
  Rows Removed by Filter: 8

Seq Scan on clinic_availability_versions (actual rows=1 loops=1)
  Rows Removed by Filter: 0
```

Plan: all three sets keep the original scans of the small clinic, service and availability-version tables

### Check professionals for a service

| Professional ID filter | Existing indexes | End-time set | Start-time set | Smallest set |
| --- | ---: | ---: | ---: | ---: |
| A specific ID | **0.073 ms** [Plan](../performance/indexes/existing-indexes/professionals-professional-plan.json) [Samples](../performance/indexes/existing-indexes/professionals-professional-samples.csv) | **0.072 ms** [Plan](../performance/indexes/combined-end/professionals-professional-plan.json) [Samples](../performance/indexes/combined-end/professionals-professional-samples.csv) | **0.071 ms** [Plan](../performance/indexes/combined-start/professionals-professional-plan.json) [Samples](../performance/indexes/combined-start/professionals-professional-samples.csv) | **0.084 ms** [Plan](../performance/indexes/combined-professional/professionals-professional-plan.json) [Samples](../performance/indexes/combined-professional/professionals-professional-samples.csv) |
| NULL | **0.135 ms** [Plan](../performance/indexes/existing-indexes/professionals-service-plan.json) [Samples](../performance/indexes/existing-indexes/professionals-service-samples.csv) | **0.219 ms** [Plan](../performance/indexes/combined-end/professionals-service-plan.json) [Samples](../performance/indexes/combined-end/professionals-service-samples.csv) | **0.140 ms** [Plan](../performance/indexes/combined-start/professionals-service-plan.json) [Samples](../performance/indexes/combined-start/professionals-service-samples.csv) | **0.125 ms** [Plan](../performance/indexes/combined-professional/professionals-service-plan.json) [Samples](../performance/indexes/combined-professional/professionals-service-samples.csv) |

[Plan, smallest set and one professional](../performance/indexes/combined-professional/professionals-professional-plan.json)

```text
Seq Scan on users (actual rows=32 loops=1)
  Rows Removed by Filter: 65

Seq Scan on professionals (actual rows=1 loops=1)
  Rows Removed by Filter: 89

Seq Scan on professional_services (actual rows=1 loops=1)
  Rows Removed by Filter: 38
```

Plan: all three sets keep the original professional, user and association scans. The end-time set includes the active-association index, but PostgreSQL does not use it

### Read reserved appointments and blocks

| Professional IDs | Dates used to build windows | Existing indexes | End-time set | Start-time set | Smallest set |
| --- | --- | ---: | ---: | ---: | ---: |
| List with one ID | One date | **20.465 ms** [Plan](../performance/indexes/existing-indexes/occupation-professional-day-plan.json) [Samples](../performance/indexes/existing-indexes/occupation-professional-day-samples.csv) | **0.892 ms** [Plan](../performance/indexes/combined-end/occupation-professional-day-plan.json) [Samples](../performance/indexes/combined-end/occupation-professional-day-samples.csv) | **0.864 ms** [Plan](../performance/indexes/combined-start/occupation-professional-day-plan.json) [Samples](../performance/indexes/combined-start/occupation-professional-day-samples.csv) | **1.470 ms** [Plan](../performance/indexes/combined-professional/occupation-professional-day-plan.json) [Samples](../performance/indexes/combined-professional/occupation-professional-day-samples.csv) |
| List with one ID | Seven consecutive dates | **25.259 ms** [Plan](../performance/indexes/existing-indexes/occupation-professional-week-plan.json) [Samples](../performance/indexes/existing-indexes/occupation-professional-week-samples.csv) | **1.006 ms** [Plan](../performance/indexes/combined-end/occupation-professional-week-plan.json) [Samples](../performance/indexes/combined-end/occupation-professional-week-samples.csv) | **0.851 ms** [Plan](../performance/indexes/combined-start/occupation-professional-week-plan.json) [Samples](../performance/indexes/combined-start/occupation-professional-week-samples.csv) | **1.051 ms** [Plan](../performance/indexes/combined-professional/occupation-professional-week-plan.json) [Samples](../performance/indexes/combined-professional/occupation-professional-week-samples.csv) |
| List with multiple IDs | One date | **62.618 ms** [Plan](../performance/indexes/existing-indexes/occupation-service-day-plan.json) [Samples](../performance/indexes/existing-indexes/occupation-service-day-samples.csv) | **26.008 ms** [Plan](../performance/indexes/combined-end/occupation-service-day-plan.json) [Samples](../performance/indexes/combined-end/occupation-service-day-samples.csv) | **28.601 ms** [Plan](../performance/indexes/combined-start/occupation-service-day-plan.json) [Samples](../performance/indexes/combined-start/occupation-service-day-samples.csv) | **24.251 ms** [Plan](../performance/indexes/combined-professional/occupation-service-day-plan.json) [Samples](../performance/indexes/combined-professional/occupation-service-day-samples.csv) |
| List with multiple IDs | Seven consecutive dates | **64.576 ms** [Plan](../performance/indexes/existing-indexes/occupation-service-week-plan.json) [Samples](../performance/indexes/existing-indexes/occupation-service-week-samples.csv) | **25.441 ms** [Plan](../performance/indexes/combined-end/occupation-service-week-plan.json) [Samples](../performance/indexes/combined-end/occupation-service-week-samples.csv) | **24.949 ms** [Plan](../performance/indexes/combined-start/occupation-service-week-plan.json) [Samples](../performance/indexes/combined-start/occupation-service-week-samples.csv) | **24.018 ms** [Plan](../performance/indexes/combined-professional/occupation-service-week-plan.json) [Samples](../performance/indexes/combined-professional/occupation-service-week-samples.csv) |

[Plan, smallest set with multiple professionals and seven dates](../performance/indexes/combined-professional/occupation-service-week-plan.json)

```text
Hash Semi Join (actual rows=1505 loops=1)
  Join Filter: ((appointment.start_at < search_window.end_at) AND (appointment.end_at > search_window.start_at))
  Rows Removed by Join Filter: 29820
  ->  Bitmap Heap Scan on appointments (actual rows=31325 loops=1)
        Rows Removed by Filter: 0
        ->  Bitmap Index Scan using appointments_reserved_idx (actual rows=31325 loops=1)
              Index Cond: ((clinic_id = '...'::uuid) AND (professional_id = ANY ('{...}'::uuid[])))
  ...

Hash Semi Join (actual rows=87 loops=1)
  Join Filter: ((block.start_at < search_window_1.end_at) AND (block.end_at > search_window_1.start_at))
  Rows Removed by Join Filter: 3801
  ->  Bitmap Heap Scan on professional_blocks (actual rows=3888 loops=1)
        Rows Removed by Filter: 0
        ->  Bitmap Index Scan using professional_blocks_idx (actual rows=3888 loops=1)
              Index Cond: ((clinic_id = '...'::uuid) AND (professional_id = ANY ('{...}'::uuid[])))
  ...
```

Plan: all three sets use both appointment and block indexes. They read 1,080 appointments and 134 blocks for one ID, or 31,325 appointments and 3,888 blocks for multiple IDs. Time overlap is checked afterward. For multiple IDs over seven dates, the time checks discard 29,820 appointment candidates and 3,801 block candidates. This remaining filtering explains why the larger request still does much more work

### Read weekly professional schedules

| Professional IDs | Existing indexes | End-time set | Start-time set | Smallest set |
| --- | ---: | ---: | ---: | ---: |
| List with one ID | **0.082 ms** [Plan](../performance/indexes/existing-indexes/schedules-professional-plan.json) [Samples](../performance/indexes/existing-indexes/schedules-professional-samples.csv) | **0.041 ms** [Plan](../performance/indexes/combined-end/schedules-professional-plan.json) [Samples](../performance/indexes/combined-end/schedules-professional-samples.csv) | **0.033 ms** [Plan](../performance/indexes/combined-start/schedules-professional-plan.json) [Samples](../performance/indexes/combined-start/schedules-professional-samples.csv) | **0.038 ms** [Plan](../performance/indexes/combined-professional/schedules-professional-plan.json) [Samples](../performance/indexes/combined-professional/schedules-professional-samples.csv) |
| List with multiple IDs | **0.248 ms** [Plan](../performance/indexes/existing-indexes/schedules-service-plan.json) [Samples](../performance/indexes/existing-indexes/schedules-service-samples.csv) | **0.169 ms** [Plan](../performance/indexes/combined-end/schedules-service-plan.json) [Samples](../performance/indexes/combined-end/schedules-service-samples.csv) | **0.175 ms** [Plan](../performance/indexes/combined-start/schedules-service-plan.json) [Samples](../performance/indexes/combined-start/schedules-service-samples.csv) | **0.264 ms** [Plan](../performance/indexes/combined-professional/schedules-service-plan.json) [Samples](../performance/indexes/combined-professional/schedules-service-samples.csv) |

[Plan, smallest set and one professional](../performance/indexes/combined-professional/schedules-professional-plan.json)

```text
Bitmap Heap Scan on professional_schedules (actual rows=10 loops=1)
  Rows Removed by Filter: 0
  ->  Bitmap Index Scan using professional_schedules_idx (actual rows=10 loops=1)
        Index Cond: ((clinic_id = '...'::uuid) AND (professional_id = ANY ('{...}'::uuid[])))
```

Plan: all three sets use the schedule index to read 10 or 290 matching rows. The smallest set's multiple-ID time is slightly above the existing-index time in this run, despite reading fewer schedule rows. Service and clinic settings and professional eligibility keep their original scan structures

### Index size

| Set | Total added size |
| --- | ---: |
| End-time set | **6,336 KiB** |
| Start-time set | **5,696 KiB** |
| Smallest set | **864 KiB** |

## Write cost comparison

### Reserved appointments

| SQL operation | Existing indexes | With end time | With start time | Without a time column |
| --- | ---: | ---: | ---: | ---: |
| Insert one reserved appointment | **0.393 ms** [Plan](../performance/indexes/existing-indexes/insert-appointment-plan.json) [Samples](../performance/indexes/existing-indexes/insert-appointment-samples.csv) | **0.246 ms** [Plan](../performance/indexes/appointments-end/insert-appointment-plan.json) [Samples](../performance/indexes/appointments-end/insert-appointment-samples.csv) | **0.223 ms** [Plan](../performance/indexes/appointments-start/insert-appointment-plan.json) [Samples](../performance/indexes/appointments-start/insert-appointment-samples.csv) | **0.330 ms** [Plan](../performance/indexes/appointments-professional/insert-appointment-plan.json) [Samples](../performance/indexes/appointments-professional/insert-appointment-samples.csv) |
| Cancel one reserved appointment | **0.162 ms** [Plan](../performance/indexes/existing-indexes/cancel-appointment-plan.json) [Samples](../performance/indexes/existing-indexes/cancel-appointment-samples.csv) | **0.165 ms** [Plan](../performance/indexes/appointments-end/cancel-appointment-plan.json) [Samples](../performance/indexes/appointments-end/cancel-appointment-samples.csv) | **0.143 ms** [Plan](../performance/indexes/appointments-start/cancel-appointment-plan.json) [Samples](../performance/indexes/appointments-start/cancel-appointment-samples.csv) | **0.263 ms** [Plan](../performance/indexes/appointments-professional/cancel-appointment-plan.json) [Samples](../performance/indexes/appointments-professional/cancel-appointment-samples.csv) |

### Professional blocks

| SQL operation | Existing indexes | With end time | With start time | Without a time column |
| --- | ---: | ---: | ---: | ---: |
| Insert one block | **0.108 ms** [Plan](../performance/indexes/existing-indexes/insert-block-plan.json) [Samples](../performance/indexes/existing-indexes/insert-block-samples.csv) | **0.101 ms** [Plan](../performance/indexes/blocks-end/insert-block-plan.json) [Samples](../performance/indexes/blocks-end/insert-block-samples.csv) | **0.106 ms** [Plan](../performance/indexes/blocks-start/insert-block-plan.json) [Samples](../performance/indexes/blocks-start/insert-block-samples.csv) | **0.095 ms** [Plan](../performance/indexes/blocks-professional/insert-block-plan.json) [Samples](../performance/indexes/blocks-professional/insert-block-samples.csv) |

### Weekly schedules

| SQL operation | Existing indexes | With this index |
| --- | ---: | ---: |
| Replace ten weekly intervals | **0.357 ms** [Plan](../performance/indexes/existing-indexes/replace-schedules-plan.json) [Samples](../performance/indexes/existing-indexes/replace-schedules-samples.csv) | **0.305 ms** [Plan](../performance/indexes/schedules/replace-schedules-plan.json) [Samples](../performance/indexes/schedules/replace-schedules-samples.csv) |

### Professional-service associations

| SQL operation | Existing indexes | With this index | With end-time set |
| --- | ---: | ---: | ---: |
| Deactivate one association | **0.138 ms** [Plan](../performance/indexes/existing-indexes/deactivate-association-plan.json) [Samples](../performance/indexes/existing-indexes/deactivate-association-samples.csv) | **0.085 ms** [Plan](../performance/indexes/associations/deactivate-association-plan.json) [Samples](../performance/indexes/associations/deactivate-association-samples.csv) | **0.057 ms** [Plan](../performance/indexes/combined-end/deactivate-association-plan.json) [Samples](../performance/indexes/combined-end/deactivate-association-samples.csv) |

### Combined indexes

| SQL operation | Existing indexes | End-time set | Start-time set | Smallest set |
| --- | ---: | ---: | ---: | ---: |
| Insert one reserved appointment | **0.393 ms** [Plan](../performance/indexes/existing-indexes/insert-appointment-plan.json) [Samples](../performance/indexes/existing-indexes/insert-appointment-samples.csv) | **0.179 ms** [Plan](../performance/indexes/combined-end/insert-appointment-plan.json) [Samples](../performance/indexes/combined-end/insert-appointment-samples.csv) | **0.180 ms** [Plan](../performance/indexes/combined-start/insert-appointment-plan.json) [Samples](../performance/indexes/combined-start/insert-appointment-samples.csv) | **0.177 ms** [Plan](../performance/indexes/combined-professional/insert-appointment-plan.json) [Samples](../performance/indexes/combined-professional/insert-appointment-samples.csv) |
| Cancel one reserved appointment | **0.162 ms** [Plan](../performance/indexes/existing-indexes/cancel-appointment-plan.json) [Samples](../performance/indexes/existing-indexes/cancel-appointment-samples.csv) | **0.129 ms** [Plan](../performance/indexes/combined-end/cancel-appointment-plan.json) [Samples](../performance/indexes/combined-end/cancel-appointment-samples.csv) | **0.128 ms** [Plan](../performance/indexes/combined-start/cancel-appointment-plan.json) [Samples](../performance/indexes/combined-start/cancel-appointment-samples.csv) | **0.126 ms** [Plan](../performance/indexes/combined-professional/cancel-appointment-plan.json) [Samples](../performance/indexes/combined-professional/cancel-appointment-samples.csv) |
| Insert one block | **0.108 ms** [Plan](../performance/indexes/existing-indexes/insert-block-plan.json) [Samples](../performance/indexes/existing-indexes/insert-block-samples.csv) | **0.081 ms** [Plan](../performance/indexes/combined-end/insert-block-plan.json) [Samples](../performance/indexes/combined-end/insert-block-samples.csv) | **0.091 ms** [Plan](../performance/indexes/combined-start/insert-block-plan.json) [Samples](../performance/indexes/combined-start/insert-block-samples.csv) | **0.087 ms** [Plan](../performance/indexes/combined-professional/insert-block-plan.json) [Samples](../performance/indexes/combined-professional/insert-block-samples.csv) |
| Replace ten weekly intervals | **0.357 ms** [Plan](../performance/indexes/existing-indexes/replace-schedules-plan.json) [Samples](../performance/indexes/existing-indexes/replace-schedules-samples.csv) | **0.355 ms** [Plan](../performance/indexes/combined-end/replace-schedules-plan.json) [Samples](../performance/indexes/combined-end/replace-schedules-samples.csv) | **0.316 ms** [Plan](../performance/indexes/combined-start/replace-schedules-plan.json) [Samples](../performance/indexes/combined-start/replace-schedules-samples.csv) | **0.301 ms** [Plan](../performance/indexes/combined-professional/replace-schedules-plan.json) [Samples](../performance/indexes/combined-professional/replace-schedules-samples.csv) |

These short write measurements vary, so they do not establish a reliable ranking. Every added index still needs maintenance on affected writes

## Recommendation

Recommend the smallest tested set

| Table | Recommended index | Reason |
| --- | --- | --- |
| appointments | Clinic and professional, reserved rows only | Same candidate rows as the time-column variants, using 728 KiB |
| professional_blocks | Clinic and professional | Same candidate rows as the time-column variants, using 104 KiB |
| professional_schedules | Clinic and professional | Reads only matching schedules, using 32 KiB |
| professional_services | Keep the existing indexes | The active-association candidate was not used |
| clinics and services | Keep the existing indexes | The settings query scans only 3 clinic rows and 9 service rows |

The set adds 864 KiB, about 86% less than the end-time set. In this run, it reduces the one-professional, one-date occupation query from **20.465 ms** to **1.470 ms**, and the multiple-professional, seven-date query from **64.576 ms** to **24.018 ms**

The start-time set is faster for one professional, while the smallest set is faster for multiple professionals in the combined tests. This recommendation favors the smaller indexes and their measured reduction in rows read. It does not claim the smallest set wins every timing comparison

These are recommendations for the tested data and queries.