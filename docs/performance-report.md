# Performance report

## Cache measurements

### Reproduction

Run `npm ci` with Node.js 24 or newer and start Docker with Compose support for `!override`. Run the following command from the repository root.

```sh
npm run measure:cache
```

The command prints the Markdown report and removes the containers, volumes, network, and local images for its Compose project.

- Run started at 2026-11-13T02:04:24.586Z (UTC)
- Git HEAD `49ee0fd435b65ae15d782b4012a9866eb3d80e8c`
- Source changes relative to HEAD (`package.json`, `scripts/test-all.ts`, `scripts/test-compose.ts`, `scripts/cache-measurement/fixtures.ts`, `scripts/cache-measurement/report.ts`, `scripts/cache-measurement/run.ts`, `scripts/cache-measurement/samples.ts`)
- Source fingerprint (SHA-256) `26881b4ce987ee918ae136070a2212f5bc904751150ec80fd9288a9811a319f6`
- Runner host darwin 27.2.0 arm64
- Runner Node.js v26.0.0
- Docker Engine 29.9.3
- Docker Compose 5.7.0
- API Node.js v24.22.3
- PostgreSQL 18.6 (Debian 18.6-1.pgdg13+2)
- Keycloak 26.8.1
- Redis 8.10.3

### Fixtures and request parameters

The fresh Compose project uses the application migrations, synthetic seed, and development Keycloak realm. Both modes use the same reception account, SQL role `reception`, and clinic RLS policies. The setup connection reads fixture and index metadata outside the requests.

- Clinic Clínica Central (`7b91beef-380c-448f-bb3e-8dad4f872569`), time zone `America/Costa_Rica`, availability version `0` before and after the run
- Service Consulta general (`42a86833-e636-4fbd-a504-a4ac8afc4943`), duration 30 minutes
- 2 eligible professionals (`cf1d7ad3-2d3f-4ac6-ac29-bff9b414c3da`, `80b3e1f5-10ad-4813-8f38-708e64ca91bd`)
- Date anchor 2026-11-16, the Monday of the selected professional's first future reserved appointment week for this service
- CW1 uses `GET /professionals/cf1d7ad3-2d3f-4ac6-ac29-bff9b414c3da/availability?serviceId=42a86833-e636-4fbd-a504-a4ac8afc4943&date=2026-11-16` with 1 expected daily unit. The cache verification accepted 1 and calculated 0.
- CW2 uses `GET /services/42a86833-e636-4fbd-a504-a4ac8afc4943/availability?from=2026-11-16&to=2026-11-22` with 14 expected daily units. The cache verification accepted 14 and calculated 0.

| Clinic | Professionals | Appointments | First appointment date | Last appointment date |
| --- | ---: | ---: | --- | --- |
| Clínica Central | 3 | 18 | 2026-11-02 | 2026-11-19 |
| Clínica Norte | 3 | 18 | 2026-11-02 | 2026-11-19 |
| Clínica Sur | 3 | 18 | 2026-11-02 | 2026-11-19 |

### Method

Direct requests calculate availability in one authorized PostgreSQL transaction. Cached requests prepare candidates in PostgreSQL, read Redis, and validate those candidates in a definitive authorized PostgreSQL transaction. Both use the same running API and database.

Before timing each workload, one cached request prepares the entries and a second confirms their acceptance through the API. Each mode then receives 3 warm-up requests. The runner executes 10 sequential pairs per workload, alternating which mode goes first, starting with direct. A monotonic clock measures each request from dispatch through receipt of the complete response body, including API authentication. JSON parsing, equality checks, and report formatting run after timing.

The client timeout is 15000 ms. API timeouts in milliseconds are `DATABASE_ACQUIRE_TIMEOUT_MS` = 1000, `DATABASE_LOCK_TIMEOUT_MS` = 1000, `DATABASE_STATEMENT_TIMEOUT_MS` = 3000, `KEYCLOAK_HTTP_TIMEOUT_MS` = 2000, `REDIS_BATCH_TIMEOUT_MS` = 500. Redis entries use a 300-second TTL.

The diagnostic header reports the units accepted from Redis and calculated from PostgreSQL. A pair contributes to both aggregates when both requests return HTTP 200, the JSON bodies are equivalent, and the observed counts confirm the requested modes. Failed requests and excluded pairs remain in the sample table.

### PostgreSQL indexes present during the run

Both modes use these index definitions from the same migrated database.

```sql
CREATE UNIQUE INDEX _prisma_migrations_pkey ON public._prisma_migrations USING btree (id);
CREATE UNIQUE INDEX appointments_clinic_appointment_key ON public.appointments USING btree (clinic_id, appointment_id);
CREATE UNIQUE INDEX appointments_pkey ON public.appointments USING btree (appointment_id);
CREATE UNIQUE INDEX appointments_previous_key ON public.appointments USING btree (clinic_id, previous_appointment_id);
CREATE UNIQUE INDEX appointments_replacement_target_key ON public.appointments USING btree (clinic_id, appointment_id, patient_id, service_id);
CREATE UNIQUE INDEX audit_records_pkey ON public.audit_records USING btree (audit_record_id);
CREATE UNIQUE INDEX clinic_availability_versions_pkey ON public.clinic_availability_versions USING btree (clinic_id);
CREATE UNIQUE INDEX clinical_notes_clinic_appointment_key ON public.clinical_notes USING btree (clinic_id, appointment_id);
CREATE UNIQUE INDEX clinical_notes_pkey ON public.clinical_notes USING btree (appointment_id);
CREATE UNIQUE INDEX clinics_pkey ON public.clinics USING btree (clinic_id);
CREATE UNIQUE INDEX patients_clinic_patient_key ON public.patients USING btree (clinic_id, patient_id);
CREATE UNIQUE INDEX patients_identification_key ON public.patients USING btree (clinic_id, identification);
CREATE UNIQUE INDEX patients_pkey ON public.patients USING btree (patient_id);
CREATE UNIQUE INDEX professional_blocks_pkey ON public.professional_blocks USING btree (professional_block_id);
CREATE UNIQUE INDEX professional_schedules_pkey ON public.professional_schedules USING btree (professional_schedule_id);
CREATE UNIQUE INDEX professional_services_pkey ON public.professional_services USING btree (clinic_id, professional_id, service_id);
CREATE UNIQUE INDEX professionals_clinic_professional_key ON public.professionals USING btree (clinic_id, professional_id);
CREATE UNIQUE INDEX professionals_pkey ON public.professionals USING btree (professional_id);
CREATE UNIQUE INDEX professionals_user_key ON public.professionals USING btree (clinic_id, user_id);
CREATE UNIQUE INDEX services_clinic_name_key ON public.services USING btree (clinic_id, name);
CREATE UNIQUE INDEX services_clinic_service_key ON public.services USING btree (clinic_id, service_id);
CREATE UNIQUE INDEX services_pkey ON public.services USING btree (service_id);
CREATE UNIQUE INDEX specialties_clinic_name_key ON public.specialties USING btree (clinic_id, name);
CREATE UNIQUE INDEX specialties_clinic_specialty_key ON public.specialties USING btree (clinic_id, specialty_id);
CREATE UNIQUE INDEX specialties_pkey ON public.specialties USING btree (specialty_id);
CREATE UNIQUE INDEX users_clinic_user_key ON public.users USING btree (clinic_id, user_id);
CREATE UNIQUE INDEX users_identity_id_key ON public.users USING btree (identity_id);
CREATE UNIQUE INDEX users_pkey ON public.users USING btree (user_id);
```

### Samples

| Workload | Pair | Order | Requested mode | Duration (ms) | HTTP | Observed mode | Accepted | Calculated | Equivalent JSON | Included | Issue |
| --- | ---: | ---: | --- | ---: | ---: | --- | ---: | ---: | --- | --- | --- |
| CW1 | 1 | 1 | direct | 2.937 | 200 | direct | 0 | 1 | Yes | Yes | - |
| CW1 | 1 | 2 | cached | 5.250 | 200 | cached | 1 | 0 | Yes | Yes | - |
| CW1 | 2 | 1 | cached | 4.976 | 200 | cached | 1 | 0 | Yes | Yes | - |
| CW1 | 2 | 2 | direct | 3.273 | 200 | direct | 0 | 1 | Yes | Yes | - |
| CW1 | 3 | 1 | direct | 3.070 | 200 | direct | 0 | 1 | Yes | Yes | - |
| CW1 | 3 | 2 | cached | 5.268 | 200 | cached | 1 | 0 | Yes | Yes | - |
| CW1 | 4 | 1 | cached | 4.690 | 200 | cached | 1 | 0 | Yes | Yes | - |
| CW1 | 4 | 2 | direct | 3.373 | 200 | direct | 0 | 1 | Yes | Yes | - |
| CW1 | 5 | 1 | direct | 2.985 | 200 | direct | 0 | 1 | Yes | Yes | - |
| CW1 | 5 | 2 | cached | 4.749 | 200 | cached | 1 | 0 | Yes | Yes | - |
| CW1 | 6 | 1 | cached | 5.221 | 200 | cached | 1 | 0 | Yes | Yes | - |
| CW1 | 6 | 2 | direct | 3.173 | 200 | direct | 0 | 1 | Yes | Yes | - |
| CW1 | 7 | 1 | direct | 3.032 | 200 | direct | 0 | 1 | Yes | Yes | - |
| CW1 | 7 | 2 | cached | 4.690 | 200 | cached | 1 | 0 | Yes | Yes | - |
| CW1 | 8 | 1 | cached | 5.607 | 200 | cached | 1 | 0 | Yes | Yes | - |
| CW1 | 8 | 2 | direct | 3.418 | 200 | direct | 0 | 1 | Yes | Yes | - |
| CW1 | 9 | 1 | direct | 2.683 | 200 | direct | 0 | 1 | Yes | Yes | - |
| CW1 | 9 | 2 | cached | 4.990 | 200 | cached | 1 | 0 | Yes | Yes | - |
| CW1 | 10 | 1 | cached | 5.121 | 200 | cached | 1 | 0 | Yes | Yes | - |
| CW1 | 10 | 2 | direct | 2.592 | 200 | direct | 0 | 1 | Yes | Yes | - |
| CW2 | 1 | 1 | direct | 5.780 | 200 | direct | 0 | 14 | Yes | Yes | - |
| CW2 | 1 | 2 | cached | 18.583 | 200 | cached | 14 | 0 | Yes | Yes | - |
| CW2 | 2 | 1 | cached | 18.901 | 200 | cached | 14 | 0 | Yes | Yes | - |
| CW2 | 2 | 2 | direct | 5.036 | 200 | direct | 0 | 14 | Yes | Yes | - |
| CW2 | 3 | 1 | direct | 4.318 | 200 | direct | 0 | 14 | Yes | Yes | - |
| CW2 | 3 | 2 | cached | 18.627 | 200 | cached | 14 | 0 | Yes | Yes | - |
| CW2 | 4 | 1 | cached | 18.500 | 200 | cached | 14 | 0 | Yes | Yes | - |
| CW2 | 4 | 2 | direct | 5.721 | 200 | direct | 0 | 14 | Yes | Yes | - |
| CW2 | 5 | 1 | direct | 7.512 | 200 | direct | 0 | 14 | Yes | Yes | - |
| CW2 | 5 | 2 | cached | 18.807 | 200 | cached | 14 | 0 | Yes | Yes | - |
| CW2 | 6 | 1 | cached | 19.227 | 200 | cached | 14 | 0 | Yes | Yes | - |
| CW2 | 6 | 2 | direct | 4.683 | 200 | direct | 0 | 14 | Yes | Yes | - |
| CW2 | 7 | 1 | direct | 4.346 | 200 | direct | 0 | 14 | Yes | Yes | - |
| CW2 | 7 | 2 | cached | 18.924 | 200 | cached | 14 | 0 | Yes | Yes | - |
| CW2 | 8 | 1 | cached | 18.375 | 200 | cached | 14 | 0 | Yes | Yes | - |
| CW2 | 8 | 2 | direct | 5.231 | 200 | direct | 0 | 14 | Yes | Yes | - |
| CW2 | 9 | 1 | direct | 5.014 | 200 | direct | 0 | 14 | Yes | Yes | - |
| CW2 | 9 | 2 | cached | 18.998 | 200 | cached | 14 | 0 | Yes | Yes | - |
| CW2 | 10 | 1 | cached | 18.567 | 200 | cached | 14 | 0 | Yes | Yes | - |
| CW2 | 10 | 2 | direct | 5.209 | 200 | direct | 0 | 14 | Yes | Yes | - |

### Aggregates

| Workload | Mode | Included samples | Mean (ms) | Median (ms) |
| --- | --- | ---: | ---: | ---: |
| CW1 | direct | 10 | 3.054 | 3.051 |
| CW1 | cached | 10 | 5.056 | 5.056 |
| CW2 | direct | 10 | 5.285 | 5.122 |
| CW2 | cached | 10 | 18.751 | 18.717 |

The direct mode had a lower mean and median in both workloads. The cached requests reused every expected unit and still ran the two PostgreSQL phases. These timings describe the measured revision, synthetic seed, and local Compose environment.

## Index evaluation
