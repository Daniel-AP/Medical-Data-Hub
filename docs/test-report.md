| Requirement | Tests |
| --- | --- |
| Malformed JSON handling and continued API operation | [rejects malformed JSON and parses a later request](../apps/api/tests/app.test.ts) |
| Unknown routes return a generic JSON response | [returns a generic JSON response for unknown routes](../apps/api/tests/app.test.ts) |
| Unexpected errors return a generic JSON response and preserve API operation | [returns a generic JSON response for unexpected errors and remains usable](../apps/api/tests/app.test.ts) |
| Payload size errors preserve their HTTP status | [preserves the payload size error status](../apps/api/tests/app.test.ts) |
