import type { RequestHandler } from "express";
import { getKeycloakAdminAccess, isKeycloakIdentityId, keycloakUserExists, replaceKeycloakUserRole } from "../clients/keycloak/admin-api.js";
import type { KeycloakAdminSettings } from "../clients/keycloak/admin-api.js";
import { isClinicUserRole } from "../clients/keycloak/roles.js";
import { checkUserCreationPermission, createUser, updateUserPermissions } from "../database/users.js";
import { isUuid } from "../validation.js";

export const createUserRequestHandler = (settings: KeycloakAdminSettings, fetchKeycloak: typeof fetch = fetch): RequestHandler => {

	return async (request, response) => {

		const body = request.body;
		const identityId: unknown = body?.identityId;
		const role: unknown = body?.role;
		const validRole = isClinicUserRole(role);
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

export const updateUserPermissionsRequestHandler = (settings: KeycloakAdminSettings, fetchKeycloak: typeof fetch = fetch): RequestHandler => {

	return async (request, response) => {

		const { userId } = request.params;
		const body = request.body;
		const role: unknown = body?.role;
		const isActive: unknown = body?.isActive;
		const validRole = role === undefined || isClinicUserRole(role);
		const validActivity = isActive === undefined || typeof isActive === "boolean";
		const emptyPatch = role === undefined && isActive === undefined;
		const hasOtherFields = Object.keys(body ?? {}).some((field) => field !== "role" && field !== "isActive");
		if(!isUuid(userId) || !validRole || !validActivity || emptyPatch || hasOtherFields) {
			throw Object.assign(new Error("Invalid user permissions"), { status: 400 });
		}

		// Authentication and role middleware run before this handler
		const permissions = await updateUserPermissions(
			request.authentication!,
			userId,
			{ role, isActive },
			async (identityId, role, markKeycloakRoleUpdateStarted) => {
				const access = await getKeycloakAdminAccess(settings, fetchKeycloak);
				await replaceKeycloakUserRole(access, identityId, role, markKeycloakRoleUpdateStarted);
			},
		);
		response.status(200).json(permissions);

	};

};
