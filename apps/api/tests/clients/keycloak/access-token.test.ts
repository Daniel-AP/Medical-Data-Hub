import { once } from "node:events";
import { createServer } from "node:http";
import type { RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWK, JWTPayload } from "jose";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createAccessTokenVerifier } from "../../../src/clients/keycloak-tokens.js";

const issuer = "http://localhost:8080/realms/medical-data-hub";
const audience = "medical-data-hub-api";
const fetchKeys = vi.fn<typeof fetch>();
let privateKey: CryptoKey;
let publicJwk: JWK;
let verifyAccessToken: ReturnType<typeof createAccessTokenVerifier>;

const createToken = (payload: JWTPayload = {}, kid = "test-key") => {

	return new SignJWT({
		iss: issuer,
		aud: audience,
		sub: "demo-user",
		exp: Math.floor(Date.now()/1000)+300,
		...payload,
	})
		.setProtectedHeader({ alg: "RS256", kid })
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
	verifyAccessToken = createAccessTokenVerifier({
		issuer,
		audience,
		jwksUrl: "http://keycloak:8080/realms/medical-data-hub/protocol/openid-connect/certs",
	});

});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

it("accepts a valid access token", async () => {
	const token = await createToken();
	await expect(verifyAccessToken(token)).resolves.toMatchObject({ iss: issuer, aud: audience, sub: "demo-user" });
});

it.each([
	["an expired access token", { exp: 0 }],
	["an access token with an incorrect issuer", { iss: "http://another-provider/realms/other" }],
	["an access token with an incorrect audience", { aud: "another-api" }],
	["an access token without expiration", { exp: undefined }],
	["an access token without a subject", { sub: undefined }],
] as const)("rejects %s with 401", async (_case, payload) => {
	const token = await createToken(payload);
	await expect(verifyAccessToken(token)).rejects.toMatchObject({ status: 401 });
});

it("rejects a malformed access token with 401", async () => {
	await expect(verifyAccessToken("invalid-token")).rejects.toMatchObject({ status: 401 });
	expect(fetchKeys).not.toHaveBeenCalled();
});

it("rejects an invalid signature with 401", async () => {

	const otherKeyPair = await generateKeyPair("RS256");
	const otherJwk = { ...(await exportJWK(otherKeyPair.publicKey)), kid: "test-key" };
	fetchKeys.mockResolvedValueOnce(Response.json({ keys: [otherJwk] }));
	const token = await createToken();
	await expect(verifyAccessToken(token)).rejects.toMatchObject({ status: 401 });

});

it("rejects an unknown signing key with 401", async () => {
	const token = await createToken({}, "unknown-key");
	await expect(verifyAccessToken(token)).rejects.toMatchObject({ status: 401 });
});

it("reports unavailable verification keys with 503", async () => {
	fetchKeys.mockRejectedValueOnce(new TypeError("fetch failed"));
	const token = await createToken();
	await expect(verifyAccessToken(token)).rejects.toMatchObject({ status: 503 });
});

it("reports a delayed JWKS response as unavailable with 503", async () => {

	vi.unstubAllGlobals();
	const requestKeys = vi.fn<RequestListener>((_request, response) => {

		response.writeHead(200, { "Content-Type": "application/json" });
		response.flushHeaders();
		const timer = setTimeout(() => response.end(JSON.stringify({ keys: [publicJwk] })), 1000);
		response.once("close", () => clearTimeout(timer));

	});
	const server = createServer(requestKeys);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");

	try {

		const { port } = server.address() as AddressInfo;
		const verify = createAccessTokenVerifier({
			issuer,
			audience,
			jwksUrl: `http://127.0.0.1:${port}`,
			timeoutMs: 250,
		});
		const token = await createToken();
		await expect(verify(token)).rejects.toMatchObject({ status: 503 });
		expect(requestKeys).toHaveBeenCalledTimes(1);

	} finally {
		server.close();
		await once(server, "close");
	}

});

it("reports an unsuccessful JWKS response with 503", async () => {
	fetchKeys.mockResolvedValueOnce(new Response(null, { status: 503 }));
	const token = await createToken();
	await expect(verifyAccessToken(token)).rejects.toMatchObject({ status: 503 });
});

it("reports a malformed JWKS with 503", async () => {
	fetchKeys.mockResolvedValueOnce(Response.json({ keys: "invalid" }));
	const token = await createToken();
	await expect(verifyAccessToken(token)).rejects.toMatchObject({ status: 503 });
});

it("reuses fresh cached keys while the provider is unavailable", async () => {

	const token = await createToken();
	await verifyAccessToken(token);
	fetchKeys.mockRejectedValue(new TypeError("fetch failed"));
	await expect(verifyAccessToken(token)).resolves.toMatchObject({ sub: "demo-user" });
	expect(fetchKeys).toHaveBeenCalledTimes(1);

});

it("refreshes cached keys after signing-key rotation", async () => {

	vi.useFakeTimers({ toFake: ["Date"] });
	const originalToken = await createToken();
	await verifyAccessToken(originalToken);

	const rotatedKeyPair = await generateKeyPair("RS256");
	const rotatedJwk = { ...(await exportJWK(rotatedKeyPair.publicKey)), kid: "rotated-key" };
	fetchKeys.mockResolvedValueOnce(Response.json({ keys: [publicJwk, rotatedJwk] }));
	vi.setSystemTime(Date.now()+31_000);

	const rotatedToken = await new SignJWT({ sub: "demo-user" })
		.setProtectedHeader({ alg: "RS256", kid: "rotated-key" })
		.setIssuer(issuer)
		.setAudience(audience)
		.setExpirationTime("5m")
		.sign(rotatedKeyPair.privateKey);

	await expect(verifyAccessToken(rotatedToken)).resolves.toMatchObject({ sub: "demo-user" });
	await expect(verifyAccessToken(originalToken)).resolves.toMatchObject({ sub: "demo-user" });
	expect(fetchKeys).toHaveBeenCalledTimes(2);

});
