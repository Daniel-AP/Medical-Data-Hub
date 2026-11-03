import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";

type KeycloakConfig = { issuer: string; jwksUrl: string; audience: string };

export function createAccessTokenVerifier(config: KeycloakConfig) {
	const jwks = createRemoteJWKSet(new URL(config.jwksUrl));

	const resolveKey: JWTVerifyGetKey = async (header, token) => {
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
