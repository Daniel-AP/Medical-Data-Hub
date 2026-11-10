export class KeycloakRoleUpdatePartialError extends Error {
	constructor(cause: unknown) {
		super("Keycloak role update partially applied", { cause });
	}
}
