import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import type { JWTPayload, JWTVerifyGetKey } from "jose";

type KeycloakConfig = { issuer: string; jwksUrl: string; audience: string };
type IdTokenContext = { identityId: string; sessionId: string; clientId: string };

function createKeyResolver(jwksUrl: string): JWTVerifyGetKey {
	const jwks = createRemoteJWKSet(new URL(jwksUrl));

	return async (header, token) => {
		try {
			return await jwks(header, token);
		} catch (error) {
			const isTokenKeyError =
				error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JOSENotSupported;
			if (isTokenKeyError) {
				throw error;
			}

			throw Object.assign(new Error("Verification keys unavailable"), { status: 503 });
		}
	};
}

export function createAccessTokenVerifier(config: KeycloakConfig) {
	const resolveKey = createKeyResolver(config.jwksUrl);

	return async (token: string) => {
		try {
			const { payload } = await jwtVerify(token, resolveKey, {
				issuer: config.issuer,
				audience: config.audience,
				requiredClaims: ["exp", "sub"],
			});

			return payload;
		} catch (error) {
			if (error instanceof errors.JOSEError) {
				throw Object.assign(new Error("Invalid access token"), { status: 401 });
			}

			throw error;
		}
	};
}

export function createLogoutIdTokenVerifier(config: Omit<KeycloakConfig, "audience">) {
	const resolveKey = createKeyResolver(config.jwksUrl);

	return async (token: string, context: IdTokenContext) => {
		const hasSessionContext = context.sessionId.length > 0 && context.clientId.length > 0;
		if (!hasSessionContext) {
			throw Object.assign(new Error("Missing session context"), { status: 401 });
		}

		let payload: JWTPayload;
		try {
			const result = await jwtVerify(token, resolveKey, {
				issuer: config.issuer,
				audience: context.clientId,
				subject: context.identityId,
				requiredClaims: ["exp", "sub", "sid"],
			});
			payload = result.payload;
		} catch (error) {
			const isExpiredIdToken = error instanceof errors.JWTExpired && error.claim === "exp";
			if (isExpiredIdToken) {
				// Expired ID tokens can identify a session for logout.
				payload = error.payload;
			} else if (error instanceof errors.JOSEError) {
				throw Object.assign(new Error("Invalid ID token"), { status: 401 });
			} else {
				throw error;
			}
		}

		const matchesSession = payload.sid === context.sessionId && payload.azp === context.clientId;
		if (payload.typ !== "ID" || !matchesSession) {
			throw Object.assign(new Error("ID token does not match the current session"), { status: 401 });
		}

		return payload;
	};
}
