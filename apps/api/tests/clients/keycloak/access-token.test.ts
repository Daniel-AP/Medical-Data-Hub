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
