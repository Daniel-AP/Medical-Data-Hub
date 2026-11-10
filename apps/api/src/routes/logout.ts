import type { RequestHandler } from "express";
import type { createLogoutIdTokenVerifier } from "../clients/keycloak.js";

type LogoutIdTokenVerifier = ReturnType<typeof createLogoutIdTokenVerifier>;

export const createLogoutRequestHandler = (verifyIdToken: LogoutIdTokenVerifier, issuer: string): RequestHandler => {

	return async (request, response) => {

		const authentication = request.authentication;
		if(!authentication?.sessionId || !authentication.clientId) {
			throw Object.assign(new Error("Missing session context"), { status: 401 });
		}

		const idToken: unknown = request.body?.idToken;
		if(typeof idToken !== "string" || idToken.length === 0) {
			throw Object.assign(new Error("Missing or invalid ID token field"), { status: 400 });
		}

		await verifyIdToken(idToken, {
			identityId: authentication.identityId,
			sessionId: authentication.sessionId,
			clientId: authentication.clientId,
		});

		const logoutUrl = new URL(`${issuer}/protocol/openid-connect/logout`);
		logoutUrl.searchParams.set("id_token_hint", idToken);
		logoutUrl.searchParams.set("client_id", authentication.clientId);

		response.set("Cache-Control", "no-store");
		response.json({ logoutUrl: logoutUrl.toString() });

	};

};
