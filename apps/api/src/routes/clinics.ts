import type { RequestHandler } from "express";
import { getKeycloakAdminAccess, isKeycloakIdentityId, keycloakUserExists, replaceKeycloakUserRole } from "../clients/keycloak-admin.js";
import type { KeycloakAdminSettings } from "../clients/types.js";
import { checkClinicCreationPermission, createClinic } from "../database/clinics.js";
import { isRequiredText } from "../validation.js";

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

export const createClinicHandler = (settings: KeycloakAdminSettings, fetchKeycloak: typeof fetch = fetch): RequestHandler => {

	return async (request, response) => {

		const body = request.body;
		const name: unknown = body?.name;
		const timeZone: unknown = body?.timeZone;
		const administratorIdentityId: unknown = body?.administratorIdentityId;
		const validName = isRequiredText(name, 200);
		const validTimeZone = isRequiredText(timeZone, 64) && isNamedTimeZone(timeZone);
		if(!validName || !validTimeZone || !isKeycloakIdentityId(administratorIdentityId)) {
			throw Object.assign(new Error("Invalid clinic registration"), { status: 400 });
		}

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
			(markRoleUpdateStarted) =>
				replaceKeycloakUserRole(access, administratorIdentityId, "clinic_administrator", markRoleUpdateStarted),
		);
		response.status(201).json(clinic);

	};

};
