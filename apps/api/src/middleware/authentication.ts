import type { RequestHandler } from "express";
import { keycloakRoles } from "../clients/keycloak/roles.js";
import type { createAccessTokenVerifier } from "../clients/keycloak/token-verification.js";
import type { UserRole } from "../generated/prisma/enums.js";

type AccessTokenVerifier = ReturnType<typeof createAccessTokenVerifier>;

export const createAuthenticationMiddleware = (verifyAccessToken: AccessTokenVerifier): RequestHandler => {

	return async (request, _response, next) => {

		const token = request.get("authorization")?.match(/^Bearer +(\S+)$/i)?.[1];
		if(!token) {
			throw Object.assign(new Error("Missing or malformed bearer token"), { status: 401 });
		}

		const payload = await verifyAccessToken(token);
		if(typeof payload.sub !== "string" || payload.sub.length === 0) {
			throw Object.assign(new Error("Invalid access token"), { status: 401 });
		}

		const resourceAccess = payload.resource_access;
		const hasResourceAccess = typeof resourceAccess === "object" && resourceAccess !== null;
		const clientAccess = hasResourceAccess
			? (resourceAccess as Record<string, unknown>)["medical-data-hub-api"]
			: undefined;
		const hasClientAccess = typeof clientAccess === "object" && clientAccess !== null;
		const tokenRoles = hasClientAccess ? (clientAccess as Record<string, unknown>).roles : undefined;
		const roles = Array.isArray(tokenRoles)
			? Object.entries(keycloakRoles)
					.filter(([tokenRole]) => tokenRoles.includes(tokenRole))
					.map(([, domainRole]) => domainRole)
			: [];

		const sessionId = typeof payload.sid === "string" ? payload.sid : undefined;
		const clientId = typeof payload.azp === "string" ? payload.azp : undefined;

		request.authentication = { identityId: payload.sub, roles, sessionId, clientId };
		next();

	};

};

export const requireRoles = (...allowedRoles: UserRole[]): RequestHandler => {

	return (request, _response, next) => {

		const authentication = request.authentication;
		if(!authentication) {
			throw Object.assign(new Error("Authentication required"), { status: 401 });
		}

		const hasAllowedRole = allowedRoles.some((role) => authentication.roles.includes(role));
		if(!hasAllowedRole) {
			throw Object.assign(new Error("Insufficient role"), { status: 403 });
		}

		next();

	};

};
