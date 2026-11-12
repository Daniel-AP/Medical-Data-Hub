import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import type { JWTPayload, JWTVerifyGetKey } from "jose";
import { keycloakTimeouts } from "../config/keycloak-timeouts.js";

type KeycloakSettings = { issuer: string; jwksUrl: string; audience: string; timeoutMs?: number };
type IdTokenContext = { identityId: string; sessionId: string; clientId: string };

const createKeyResolver = (jwksUrl: string, timeoutMs = keycloakTimeouts.requestMs): JWTVerifyGetKey => {

	const jwks = createRemoteJWKSet(new URL(jwksUrl), { timeoutDuration: timeoutMs });

	return async (header, token) => {

		try {
			return await jwks(header, token);
		} catch (error) {

			const isTokenKeyError = error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JOSENotSupported;
			if(isTokenKeyError) {
				throw error;
			}

			throw Object.assign(new Error("Verification keys unavailable"), { status: 503 });

		}

	};

};

export const createAccessTokenVerifier = (settings: KeycloakSettings) => {

	const resolveKey = createKeyResolver(settings.jwksUrl, settings.timeoutMs);

	return async (token: string) => {

		try {

			const { payload } = await jwtVerify(token, resolveKey, {
				issuer: settings.issuer,
				audience: settings.audience,
				requiredClaims: ["exp", "sub"],
			});

			return payload;

		} catch (error) {

			if(error instanceof errors.JOSEError) {
				throw Object.assign(new Error("Invalid access token"), { status: 401 });
			}

			throw error;

		}

	};

};

export const createLogoutIdTokenVerifier = (settings: Omit<KeycloakSettings, "audience">) => {

	const resolveKey = createKeyResolver(settings.jwksUrl, settings.timeoutMs);

	return async (token: string, context: IdTokenContext) => {

		let payload: JWTPayload;
		try {

			const result = await jwtVerify(token, resolveKey, {
				issuer: settings.issuer,
				audience: context.clientId,
				subject: context.identityId,
				requiredClaims: ["exp"],
			});
			payload = result.payload;

		} catch (error) {

			if(error instanceof errors.JWTExpired) {
				// Expired ID tokens still identify the logout session
				payload = error.payload;
			} else if(error instanceof errors.JOSEError) {
				throw Object.assign(new Error("Invalid ID token"), { status: 401 });
			} else {
				throw error;
			}

		}

		const matchesSession = payload.sid === context.sessionId && payload.azp === context.clientId;
		if(payload.typ !== "ID" || !matchesSession) {
			throw Object.assign(new Error("ID token does not match the current session"), { status: 401 });
		}

		return payload;

	};

};
