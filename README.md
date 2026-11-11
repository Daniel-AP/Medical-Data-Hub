# Medical-Data-Hub

## Clinical Notes API

### Create a clinical note

`POST /appointments/:appointmentId/clinical-note` creates a note for an attended appointment. Send a Keycloak bearer access token and a JSON body with only `content`. The appointment ID must be a UUID. Content must be a string with at least one non-whitespace character and no NUL characters. The API stores it as submitted.

| Status | Result |
| --- | --- |
| `201` | Returns `{"appointmentId":"<uuid>","created":true}` after the note and its write event commit. |
| `400` | Invalid appointment ID, JSON, or body fields. |
| `401` | Missing or invalid access token. |
| `403` | The token role or local authorization denies creation. |
| `404` | The appointment is absent or outside the authenticated treating professional's scope. |
| `409` | The appointment has a state other than `attended` or a note already exists. |
| `413` | The request exceeds the API's JSON body limit. |
| `500` | An unexpected failure occurred. An unconfirmed commit includes `OPERATION_OUTCOME_UNKNOWN`. |
| `503` | A transient transaction failure prevented confirmation. |

### Retrieve a clinical note

`GET /appointments/:appointmentId/clinical-note` takes an appointment UUID and requires a Keycloak bearer access token for the treating professional. The API derives the clinic and professional from authorization.

| Status | Result |
| --- | --- |
| `200` | Returns `{"appointmentId":"<uuid>","content":"<text>"}` with `Cache-Control: no-store` after the read event commits. |
| `400` | Invalid appointment ID. |
| `401` | Missing or invalid access token. |
| `403` | The token role or local authorization denies retrieval. |
| `404` | The note is absent or outside the authenticated treating professional's scope. |
| `500` | An unexpected failure occurred. An unconfirmed commit includes `OPERATION_OUTCOME_UNKNOWN`. |
| `503` | A transient transaction failure prevented confirmation. |

### Clinical note integration tests

Point the API at a seeded, disposable PostgreSQL database in an isolated Compose project with Keycloak. Set `CLINICAL_NOTE_TEST_API_URL` to the API origin, `CLINICAL_NOTE_TEST_DATABASE_SETUP_URL` to the privileged connection URL for the disposable database, and `CLINICAL_NOTE_TEST_PROFESSIONAL_TOKEN` and `CLINICAL_NOTE_TEST_RECEPTION_TOKEN` to valid tokens for the seeded roles. The suite commits synthetic notes and audit events. Its temporary audit triggers each target one synthetic appointment and action.

```sh
npx vitest run --config vitest-http.config.ts apps/api/tests/routes/clinical-notes.integration.test.ts
```

## Appointment Queries API

### Retrieve a patient's appointment history

`GET /patients/:patientId/appointments` accepts a patient UUID and a Keycloak bearer access token. Clinic administrators, reception users, and healthcare professionals can retrieve the full appointment history of a patient in their own clinic. The route accepts no query parameters.

The response includes all persisted appointment states. Each entry contains `appointmentId`, `patientId`, `professionalId`, `serviceId`, `startAt`, `endAt`, `state`, and `previousAppointmentId`. The timestamps are ISO 8601 UTC strings. Results are sorted by `startAt` descending, then by `appointmentId` ascending. A replacement references its immediate predecessor. `previousAppointmentId` is null for an appointment with no predecessor.

| Status | Result |
| --- | --- |
| `200` | Returns `{"appointments":[...]}` with `Cache-Control: no-store` after commit. The list is empty for an accessible patient without appointments. |
| `400` | Invalid patient UUID or query parameters were supplied. |
| `401` | Missing or invalid access token. |
| `403` | The token role or local authorization denies access. |
| `404` | The patient is absent or belongs to another clinic. |
| `500` | An unexpected failure occurred. An unconfirmed commit includes `OPERATION_OUTCOME_UNKNOWN`. |
| `503` | Keycloak verification keys are unavailable or a transient transaction failure prevents confirmation. |

### Retrieve a daily agenda

Each route requires a Keycloak bearer access token and exactly one `date=YYYY-MM-DD` query parameter. The date is a calendar date from year 0001 through 9999, interpreted in the authenticated clinic's time zone.

| Route | Access |
| --- | --- |
| `GET /appointments/agenda?date=YYYY-MM-DD` | Reception reads all professionals in its clinic. |
| `GET /professionals/:professionalId/agenda?date=YYYY-MM-DD` | Reception reads a professional identified by UUID in its clinic. |
| `GET /professionals/me/agenda?date=YYYY-MM-DD` | A healthcare professional reads the agenda of their protected local association. |

The response includes all persisted appointment states and the same eight metadata fields as patient history. Results are sorted by `startAt` ascending, then by `appointmentId` ascending, with UTC timestamps. An appointment appears on each local date it overlaps. An appointment ending exactly at midnight belongs to the previous day. Repeated midnights retain both occurrences, and a date skipped by a time zone transition has an empty agenda.

| Status | Result |
| --- | --- |
| `200` | Returns `{"appointments":[...]}` with `Cache-Control: no-store` after commit. A valid agenda without appointments returns an empty list. |
| `400` | Missing, malformed, repeated, or additional query parameters, an invalid calendar date, or an invalid professional UUID. |
| `401` | Missing or invalid access token. |
| `403` | The token role or local authorization denies access, including a professional without a local association for the own-agenda route. |
| `404` | The professional requested by reception is absent or belongs to another clinic. |
| `500` | An unexpected failure occurred. An unconfirmed commit includes `OPERATION_OUTCOME_UNKNOWN`. |
| `503` | Keycloak verification keys are unavailable or a transient transaction failure prevents confirmation. |

### Count appointments by state

`GET /appointments/counts?from=YYYY-MM-DD&to=YYYY-MM-DD` requires a Keycloak bearer access token for a clinic administrator. The clinic comes from local authorization. Supply exactly one `from` and one `to`, each a calendar date from year 0001 through 9999 in the clinic's time zone. Both dates are inclusive and may be equal.

Each appointment contributes one count to its persisted state on the local date of its start. An appointment that crosses midnight is counted on its start date. The response includes all five states, with zero for each state that has no matching appointments.

```json
{"counts":{"reserved":0,"attended":0,"absent":0,"cancelled":0,"rescheduled":0}}
```

| Status | Result |
| --- | --- |
| `200` | Returns the counts with `Cache-Control: no-store` after commit. A valid empty range returns zero for every state. |
| `400` | Missing, malformed, repeated, or additional query parameters, an invalid calendar date, or `from` after `to`. |
| `401` | Missing or invalid access token. |
| `403` | The token role or local authorization denies access. |
| `500` | An unexpected failure occurred. An unconfirmed commit includes `OPERATION_OUTCOME_UNKNOWN`. |
| `503` | Keycloak verification keys are unavailable or a transient transaction failure prevents confirmation. |

### Appointment query integration tests

Start a seeded, disposable Compose project with the API, PostgreSQL, and Keycloak. Publish PostgreSQL on a loopback port for the test runner. Set `APPOINTMENT_QUERY_TEST_API_URL` to the API origin and `APPOINTMENT_QUERY_TEST_DATABASE_SETUP_URL` to the privileged connection URL for the disposable database. Set `APPOINTMENT_QUERY_TEST_ADMIN_TOKEN`, `APPOINTMENT_QUERY_TEST_RECEPTION_TOKEN`, `APPOINTMENT_QUERY_TEST_PROFESSIONAL_TOKEN`, and `APPOINTMENT_QUERY_TEST_PLATFORM_TOKEN` to valid Keycloak access tokens. Use seeded clinic administrator, reception, and professional accounts from the same clinic and the seeded platform administrator account. The suites insert and remove synthetic patients and appointments. The agenda and count suites temporarily change the seeded clinic's time zone for transition cases and restore it after each case. The HTTP configuration runs files sequentially.

```sh
npx vitest run --config vitest-http.config.ts \
  apps/api/tests/routes/appointment-queries.integration.test.ts \
  apps/api/tests/routes/appointment-agendas.integration.test.ts \
  apps/api/tests/routes/appointment-counts.integration.test.ts
```
