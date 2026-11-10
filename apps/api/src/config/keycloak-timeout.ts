import { readTimeout } from "./read-timeout.js";

export const keycloakHttpTimeoutMs = readTimeout("KEYCLOAK_HTTP_TIMEOUT_MS", 2000);
