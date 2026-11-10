# Medical-Data-Hub

## Clinic API

All routes below require a bearer access token.

### `POST /clinics`

A platform administrator registers a clinic and its first administrator. See the [registration design](docs/design.md#clinic-registration-endpoint).

- `name` is a nonblank string of up to 200 characters
- `timeZone` is a named time zone of up to 64 characters, such as `America/Costa_Rica` or `UTC`
- `administratorIdentityId` is a nonblank Keycloak user ID of up to 255 characters
- Success returns `201` with `{ clinicId, administratorUserId }`

### `POST /users`

A clinic administrator registers a user in their clinic. See the [registration design](docs/design.md#clinic-user-registration-endpoint).

- Send exactly `identityId` and `role`. The identity is a nonblank Keycloak user ID of up to 255 characters
- The role is `clinic_administrator`, `reception`, or `healthcare_professional`
- Success returns `201` with `{ userId }`

Both registration routes return `400` for invalid fields, `404` when the Keycloak identity is missing, and `409` when the identity is already linked to a local user.

## Audit API

A clinic administrator queries audit metadata with `GET /audit-records`. See the [query design](docs/design.md#audit-record-query).

- Optional filters are `userId` and `patientId` (UUIDs), inclusive `from`, and exclusive `to`
- Timestamps use `YYYY-MM-DDTHH:mm`. Seconds are optional and can include up to three fractional digits. The zone is `Z` or a signed `HH`, `HHmm`, or `HH:mm` offset
- Invalid, repeated, or unknown filters return `400`, including `clinicId` and any range with `from >= to`
- Success returns `200` with `{ records: [...] }`. Records contain `auditRecordId`, `clinicId`, `userId`, `patientId`, `resource`, `appointmentId`, `action`, and `occurredAt` in UTC. Results sort by `occurredAt` descending, then `auditRecordId` descending

## Session API

`POST /auth/logout-request` accepts a bearer access token and a JSON body with `idToken`. It returns `200` with `{ logoutUrl }` and `Cache-Control: no-store`. The client opens the returned URL, which includes `id_token_hint` and `client_id`, to complete [current-session logout](docs/design.md#logout).

## Shared error responses

- `400` for malformed JSON or invalid request data
- `401` for a missing or invalid token, and `403` for a caller without the required permission
- `503` for unavailable verification keys, Keycloak administration failures before a provider mutation, SQL connection or timeout failures, or an exhausted retryable transaction abort
- `500` for other technical failures. `KEYCLOAK_ROLE_UPDATE_PARTIAL` means the role was added but removal of earlier roles was rejected. `OPERATION_OUTCOME_UNKNOWN` means a commit or provider change is unconfirmed, or a database failure followed a marked provider mutation. Both cases may require manual reconciliation

Error responses omit internal driver and provider details.
