import { once } from "node:events";
import { STATUS_CODES } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { app, router } from "../src/app.js";
import type { createAccessTokenVerifier, createLogoutIdTokenVerifier } from "../src/clients/keycloak.js";
import { createAuthenticationMiddleware } from "../src/middleware/authentication.js";
import { createLogoutRequestHandler } from "../src/routes/logout.js";

const issuer = "http://localhost:8080/realms/medical-data-hub";
const verifyAccessToken = vi.fn<ReturnType<typeof createAccessTokenVerifier>>();
const verifyIdToken = vi.fn<ReturnType<typeof createLogoutIdTokenVerifier>>();
const context = { identityId: "demo-user", sessionId: "demo-session", clientId: "medical-data-hub-postman" };
const requestOptions = {
	method: "POST",
	headers: { "Content-Type": "application/json", Authorization: "Bearer demo-access-token" },
};
let server: Server;
let url: string;

beforeAll(async () => {
	router.post(
		"/auth/logout-request",
		createAuthenticationMiddleware(verifyAccessToken),
		createLogoutRequestHandler(verifyIdToken, issuer),
	);

	server = app.listen(0, "127.0.0.1");
	await once(server, "listening");
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/logout-request`;
});

beforeEach(() => {
	verifyAccessToken.mockReset();
	verifyAccessToken.mockResolvedValue({ sub: context.identityId, sid: context.sessionId, azp: context.clientId });
	verifyIdToken.mockReset();
	verifyIdToken.mockResolvedValue({});
});

afterAll(async () => {
	server.close();
	await once(server, "close");
});

it("returns a non-cacheable Keycloak logout URL after verifying the ID token against the authenticated session", async () => {
	const response = await fetch(url, { ...requestOptions, body: JSON.stringify({ idToken: "demo-id-token" }) });

	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(await response.json()).toEqual({
		logoutUrl: `${issuer}/protocol/openid-connect/logout?id_token_hint=demo-id-token&client_id=medical-data-hub-postman`,
	});
	expect(verifyIdToken).toHaveBeenCalledWith("demo-id-token", context);
});

it("ignores user, session, and client identifiers supplied in the logout body", async () => {
	const response = await fetch(url, {
		...requestOptions,
		body: JSON.stringify({
			idToken: "demo-id-token",
			identityId: "another-user",
			sessionId: "another-session",
			clientId: "another-client",
		}),
	});

	expect(response.status).toBe(200);
	expect(verifyIdToken).toHaveBeenCalledWith("demo-id-token", context);
});

it("rejects a logout request without a bearer token with 401", async () => {
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ idToken: "demo-id-token" }),
	});

	expect(response.status).toBe(401);
	expect(verifyIdToken).not.toHaveBeenCalled();
});

it.each([undefined, null, 42, ""])("rejects an unusable logout ID token field (%s) with 400", async (idToken) => {
	const response = await fetch(url, { ...requestOptions, body: JSON.stringify({ idToken }) });

	expect(response.status).toBe(400);
	expect(verifyIdToken).not.toHaveBeenCalled();
});

it.each([
	["a missing session", { sid: undefined }],
	["an empty session", { sid: "" }],
	["a missing client", { azp: undefined }],
	["an empty client", { azp: "" }],
] as const)("rejects a logout request with %s with 401", async (_case, claims) => {
	verifyAccessToken.mockResolvedValueOnce({
		sub: context.identityId,
		sid: context.sessionId,
		azp: context.clientId,
		...claims,
	});
	const response = await fetch(url, { ...requestOptions, body: JSON.stringify({ idToken: "demo-id-token" }) });

	expect(response.status).toBe(401);
	expect(verifyIdToken).not.toHaveBeenCalled();
});

it("preserves ID token verification failures as a generic 401 logout response", async () => {
	verifyIdToken.mockRejectedValueOnce(
		Object.assign(new Error("ID token belongs to another session"), { status: 401 }),
	);
	const response = await fetch(url, { ...requestOptions, body: JSON.stringify({ idToken: "demo-id-token" }) });

	expect(response.status).toBe(401);
	expect(await response.json()).toEqual({ error: STATUS_CODES[401] });
});

it("preserves unavailable ID token verification keys as a generic 503 logout response", async () => {
	verifyIdToken.mockRejectedValueOnce(Object.assign(new Error("Verification keys unavailable"), { status: 503 }));
	const response = await fetch(url, { ...requestOptions, body: JSON.stringify({ idToken: "demo-id-token" }) });

	expect(response.status).toBe(503);
	expect(await response.json()).toEqual({ error: STATUS_CODES[503] });
});
