import type { RequestHandler } from "express";
import { getKeycloakAdminAccess, keycloakUserExists, replaceKeycloakUserRole } from "../clients/keycloak/admin-api.js";
import type { KeycloakAdminSettings } from "../clients/keycloak/admin-api.js";
import { checkClinicCreationPermission, createClinic } from "../database/clinics.js";

const isRequiredText = (value: unknown, maxLength: number): value is string => {
	return typeof value === "string" && value.trim() !== "" && [...value].length <= maxLength && !value.includes("\0");
};

const isNamedTimeZone = (timeZone: string) => {

	if(timeZone.startsWith("+") || timeZone.startsWith("-")) {
		return false;
	}

	try {
		new Intl.DateTimeFormat("en", { timeZone });

		return true;
	} catch {
		return false;
	}

};

export const createClinicRequestHandler = (settings: KeycloakAdminSettings, fetchKeycloak: typeof fetch = fetch): RequestHandler => {

	return async (request, response) => {

		const name: unknown = request.body?.name;
		const timeZone: unknown = request.body?.timeZone;
		const administratorIdentityId: unknown = request.body?.administratorIdentityId;
		const validName = isRequiredText(name, 200);
		const validTimeZone = isRequiredText(timeZone, 64) && isNamedTimeZone(timeZone);
		const validIdentity =
			isRequiredText(administratorIdentityId, 255) &&
			administratorIdentityId !== "." && administratorIdentityId !== "..";
		if(!validName || !validTimeZone || !validIdentity) {
			throw Object.assign(new Error("Invalid clinic registration"), { status: 400 });
		}

		// Authentication and role middleware run before this handler
		const authentication = request.authentication!;
		await checkClinicCreationPermission(authentication);

		const access = await getKeycloakAdminAccess(settings, fetchKeycloak);
		const identityExists = await keycloakUserExists(access, administratorIdentityId);
		if(!identityExists) {
			throw Object.assign(new Error("Administrator identity not found"), { status: 404 });
		}

		const clinic = await createClinic(
			authentication,
			{ name, timeZone, administratorIdentityId },
			(markKeycloakRoleUpdateStarted) =>
				replaceKeycloakUserRole(access, administratorIdentityId, "clinic_administrator", markKeycloakRoleUpdateStarted),
		);
		response.status(201).json(clinic);

	};

};
