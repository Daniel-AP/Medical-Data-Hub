import type { RequestHandler } from "express";
import { getKeycloakAdminAccess, isKeycloakIdentityId, keycloakUserExists, replaceKeycloakUserRole } from "../clients/keycloak/admin-api.js";
import type { KeycloakAdminSettings } from "../clients/keycloak/admin-api.js";
import { checkUserCreationPermission, createUser } from "../database/users.js";

export const createUserRequestHandler = (settings: KeycloakAdminSettings, fetchKeycloak: typeof fetch = fetch): RequestHandler => {

	return async (request, response) => {

		const body = request.body;
		const identityId: unknown = body?.identityId;
		const role: unknown = body?.role;
		const validRole = role === "clinic_administrator" || role === "reception" || role === "healthcare_professional";
		const hasOtherFields = Object.keys(body ?? {}).some((field) => field !== "identityId" && field !== "role");
		if(!isKeycloakIdentityId(identityId) || !validRole || hasOtherFields) {
			throw Object.assign(new Error("Invalid user registration"), { status: 400 });
		}

		// Authentication and role middleware run before this handler
		const authentication = request.authentication!;
		await checkUserCreationPermission(authentication);

		const access = await getKeycloakAdminAccess(settings, fetchKeycloak);
		const identityExists = await keycloakUserExists(access, identityId);
		if(!identityExists) {
			throw Object.assign(new Error("User identity not found"), { status: 404 });
		}

		const user = await createUser(
			authentication,
			{ identityId, role },
			(markKeycloakRoleUpdateStarted) => replaceKeycloakUserRole(access, identityId, role, markKeycloakRoleUpdateStarted),
		);
		response.status(201).json(user);

	};

};
