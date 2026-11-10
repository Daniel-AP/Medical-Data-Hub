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
