import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWK, JWTPayload } from "jose";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createLogoutIdTokenVerifier } from "../../../src/clients/keycloak-tokens.js";

const issuer = "http://localhost:8080/realms/medical-data-hub";
const context = { identityId: "demo-user", sessionId: "demo-session", clientId: "medical-data-hub-postman" };
const fetchKeys = vi.fn<typeof fetch>();
let privateKey: CryptoKey;
let publicJwk: JWK;
let verifyIdToken: ReturnType<typeof createLogoutIdTokenVerifier>;

const createToken = (payload: JWTPayload = {}) => {

	return new SignJWT({
		iss: issuer,
		aud: context.clientId,
		sub: context.identityId,
		sid: context.sessionId,
		azp: context.clientId,
		typ: "ID",
		exp: Math.floor(Date.now()/1000)+300,
		...payload,
	})
		.setProtectedHeader({ alg: "RS256", kid: "test-key" })
		.sign(privateKey);

};

beforeAll(async () => {
	const keyPair = await generateKeyPair("RS256");
	privateKey = keyPair.privateKey;
	publicJwk = { ...(await exportJWK(keyPair.publicKey)), kid: "test-key" };
});

beforeEach(() => {

	fetchKeys.mockReset();
	fetchKeys.mockImplementation(async () => Response.json({ keys: [publicJwk] }));
	vi.stubGlobal("fetch", fetchKeys);
	verifyIdToken = createLogoutIdTokenVerifier({
		issuer,
		jwksUrl: "http://keycloak:8080/realms/medical-data-hub/protocol/openid-connect/certs",
	});

});

afterEach(() => {
	vi.unstubAllGlobals();
});

it.each([
	["an ID token with an incorrect issuer", { iss: "http://another-provider/realms/other" }],
	["an ID token intended for another client", { aud: "another-client" }],
	["an ID token belonging to another user", { sub: "another-user" }],
	["an ID token belonging to another session of the same user", { sid: "another-session" }],
	["an ID token with a different authorized party", { azp: "another-client" }],
	["a bearer token used as an ID token", { typ: "Bearer" }],
	["an ID token without expiration", { exp: undefined }],
	["an ID token without a subject", { sub: undefined }],
	["an ID token without a session", { sid: undefined }],
	["an expired ID token without a session", { exp: 0, sid: undefined }],
	["an expired ID token with an incorrect issuer", { exp: 0, iss: "http://another-provider/realms/other" }],
] as const)("rejects %s with 401", async (_case, payload) => {
	const token = await createToken(payload);
	await expect(verifyIdToken(token, context)).rejects.toMatchObject({ status: 401 });
});
