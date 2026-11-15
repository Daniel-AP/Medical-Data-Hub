# Medical-Data-Hub

MediCitas Stage 1 is a multi-tenant medical appointment API backed by PostgreSQL, Keycloak, and Redis.

## Run locally

From the repository root, with Docker running:

```sh
cp .env.example .env
docker compose up --build
```

The API listens at `http://localhost:3000` and Keycloak at `http://localhost:8080`. Compose applies the migrations, loads synthetic data, and imports the `medical-data-hub` realm with test users and roles.

## Run tests

With Node.js 24 or later and Docker Compose supporting `!override`, run `npm run test:all` from the repository root. It installs locked dependencies if needed, generates the Prisma client, and runs unit tests followed by PostgreSQL, API, and Keycloak integration tests in a disposable Compose project. It uses `.env.example`, loads its own fixtures, obtains test tokens, and removes the test project after the run. A failure returns a nonzero exit status. For unit tests alone, run `npm test` after dependencies and the Prisma client are ready.

## HTTP contract

All routes require a Keycloak access token in `Authorization: Bearer <token>`.

Roles in the table are **PA** (platform administrator), **CA** (clinic administrator), **R** (reception), and **HP** (healthcare professional). Clinic scope comes from the authenticated identity. Send bodies as JSON. `?` marks optional fields and each PATCH requires at least one field. Domain IDs are UUIDs. Calendar dates use `YYYY-MM-DD` and agenda dates use the clinic's time zone. Timestamps require `Z` or a UTC offset.

Shared errors are `400` for invalid input, `401` for missing or invalid authentication, `403` for denied access, `500` for an internal failure, and `503` for temporary authentication or database failures. Errors usually return `{ error }`. An indeterminate commit adds `code: "OPERATION_OUTCOME_UNKNOWN"`. A partially applied Keycloak role update adds `code: "KEYCLOAK_ROLE_UPDATE_PARTIAL"`.

| Method and path | Roles | Body or query | Success | Route-specific errors |
| --- | --- | --- | --- | --- |
| `POST /auth/logout-request` | Authenticated session | `idToken` from that session | `200 { logoutUrl }` to open in the user agent | |
| `POST /clinics` | PA | `name, timeZone, administratorIdentityId` | `201 { clinicId, administratorUserId }` | `404` identity missing, `409` identity registered |
| `POST /users` | CA | `identityId, role` | `201 { userId }` | `404` identity missing, `409` identity registered |
| `PATCH /users/:userId` | CA | `role?, isActive?` | `200 { userId, role, isActive }` | |
| `POST /specialties` | CA | `name` | `201 { specialtyId }` | `409` duplicate name |
| `POST /services` | CA | `name, durationMinutes, specialtyId` | `201 { serviceId }` | `404` specialty unavailable, `409` duplicate name |
| `PATCH /services/:serviceId` | CA | `name?, durationMinutes?, specialtyId?, isActive?` | `200 { serviceId, name, durationMinutes, specialtyId, isActive }` | `404` service or specialty unavailable, `409` duplicate name or conflicting reservations or associations |
| `POST /professionals` | CA | `userId, specialtyId` | `201 { professionalId }` | `404` user or specialty unavailable, `409` wrong user role or existing profile |
| `PATCH /professionals/:professionalId` | CA | `specialtyId` | `200 { professionalId, specialtyId }` | `404` professional or specialty unavailable, `409` active service associations |
| `POST /professionals/:professionalId/services` | CA | `serviceId` | `201 { professionalId, serviceId }` | `404` professional or service unavailable, `409` duplicate or specialty mismatch |
| `PATCH /professionals/:professionalId/services/:serviceId` | CA | `isActive` | `200 { professionalId, serviceId, isActive }` | `404` resource unavailable, `409` specialty mismatch or reserved appointments prevent change |
| `GET /professionals/:professionalId/schedules` | CA, R, HP | | `200 { intervals: [{ weekday, startMinute, endMinute }] }` | `404` professional unavailable |
| `PUT /professionals/:professionalId/schedules` | CA, own HP | `intervals: [{ weekday, startMinute, endMinute }]`, Monday = 1, `0 <= startMinute < endMinute <= 1440` | `204` | `404` professional unavailable, `409 { error, conflicts }` when reservations lose coverage |
| `GET /professionals/:professionalId/blocks` | CA, R, HP | | `200 { blocks: [{ professionalBlockId, startAt, endAt }] }` | `404` professional unavailable |
| `POST /professionals/:professionalId/blocks` | CA, own HP | `startAt, endAt` with `startAt < endAt` | `201 { professionalBlockId }` | `404` professional unavailable, `409 { error, conflicts }` when reservations overlap |
| `GET /professionals/:professionalId/availability` (RF7) | CA, R, HP | Query `serviceId, date` | `200 { professionalId, serviceId, date, starts }` | `404` professional or service unavailable, `409` professional ineligible |
| `GET /services/:serviceId/availability` (RF8) | CA, R, HP | Query `from, to` | `200 { serviceId, dates: [{ date, professionals: [{ professionalId, starts }] }] }` | `404` service unavailable |
| `POST /patients` | CA, R | `identification, name, dateOfBirth, email?, phone?` with at least one contact | `201 { patientId, created: true }` | `409` duplicate identification |
| `PATCH /patients/:patientId` | CA, R | `identification?, name?, dateOfBirth?, email?, phone?` | `200 { patientId, updated: true }` | `404` patient unavailable, `409` duplicate identification |
| `GET /patients/:patientId` | CA, R, HP | | `200 { patientId, identification, name, dateOfBirth, email, phone }` | `404` patient unavailable |
| `GET /patients/:patientId/appointments` | CA, R, HP | | `200 { appointments }` | `404` patient unavailable |
| `POST /appointments` (RF9) | CA, R | `patientId, professionalId, serviceId, startAt` | `201 { appointmentId }` when booked | `400` invalid request, `404` resource unavailable, `409` slot taken, blocked, outside schedule, or ineligible |
| `POST /appointments/:appointmentId/reschedule` | CA, R | `professionalId, startAt` | `201 { appointmentId }` of replacement | `404` resource unavailable, `409` original no longer reserved or destination conflicts |
| `POST /appointments/:appointmentId/cancel` | CA, R | `cancellationReason` (1-500 characters) | `200 { appointmentId }` | `404` appointment unavailable, `409` appointment no longer reserved |
| `POST /appointments/:appointmentId/outcome` | CA, R, own HP | `state` (`attended` or `absent`) | `200 { appointmentId }` | `404` appointment unavailable, `409` appointment has yet to start or is no longer reserved |
| `GET /appointments/agenda` | R | Query `date` | `200 { appointments }` | |
| `GET /professionals/:professionalId/agenda` | R | Query `date` | `200 { appointments }` | `404` professional unavailable |
| `GET /professionals/me/agenda` | HP | Query `date` | `200 { appointments }` | `404` professional unavailable |
| `GET /appointments/counts` | CA | Query `from, to` (inclusive by local start date) | `200 { counts: { reserved, attended, absent, cancelled, rescheduled } }` | |
| `POST /appointments/:appointmentId/clinical-note` | Own HP | `content` | `201 { appointmentId, created: true }` | `404` appointment unavailable, `409` appointment not attended or note exists |
| `GET /appointments/:appointmentId/clinical-note` | Own HP | | `200 { appointmentId, content }` | `404` note unavailable |
| `GET /audit-records` | CA | Query `userId?, patientId?, from?, to?` (timestamps, inclusive start and exclusive end) | `200 { records }` | |

[Design](docs/design.md) / [Test coverage](docs/test-report.md) / [Cache measurements](docs/performance-report.md) / [Index evaluation](docs/index-evaluation.md) / [AI usage](docs/ai-usage.md)
