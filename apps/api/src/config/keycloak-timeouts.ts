import { readTimeout } from "./read-timeout.js";

export const keycloakTimeouts = {
	requestMs: readTimeout("KEYCLOAK_HTTP_TIMEOUT_MS", 2000),
};
