import type { RequestHandler } from "express";
import type { createAccessTokenVerifier } from "../clients/keycloak.js";

type AccessTokenVerifier = ReturnType<typeof createAccessTokenVerifier>;

export function createAuthenticationMiddleware(verifyAccessToken: AccessTokenVerifier): RequestHandler {
	return async (request, _response, next) => {
		const token = request.get("authorization")?.match(/^Bearer +(\S+)$/i)?.[1];
		if (!token) {
			throw Object.assign(new Error("Missing or malformed bearer token"), { status: 401 });
		}

		const payload = await verifyAccessToken(token);
		if (typeof payload.sub !== "string" || payload.sub.length === 0) {
			throw Object.assign(new Error("Invalid access token"), { status: 401 });
		}

		request.authentication = { identityId: payload.sub };
		next();
	};
}
