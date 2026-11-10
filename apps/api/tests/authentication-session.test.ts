import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { app, router } from "../src/app.js";
import type { createAccessTokenVerifier } from "../src/clients/keycloak.js";
import { createAuthenticationMiddleware } from "../src/middleware/authentication.js";

const verifyAccessToken = vi.fn<ReturnType<typeof createAccessTokenVerifier>>();
let server: Server;
let url: string;

beforeAll(async () => {

	router.get("/session-check", createAuthenticationMiddleware(verifyAccessToken), (request, response) => {
		response.json(request.authentication);
	});

	server = app.listen(0, "127.0.0.1");
	await once(server, "listening");
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/session-check`;

});

beforeEach(() => {
	verifyAccessToken.mockReset();
});

afterAll(async () => {
	server.close();
	await once(server, "close");
});

it("passes the verified session and authorized client to the route", async () => {

	verifyAccessToken.mockResolvedValueOnce({ sub: "demo-user", sid: "demo-session", azp: "medical-data-hub-postman" });

	const response = await fetch(url, { headers: { Authorization: "Bearer demo-token" } });

	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({
		identityId: "demo-user",
		roles: [],
		sessionId: "demo-session",
		clientId: "medical-data-hub-postman",
	});

});

it("authenticates an access token without session metadata", async () => {

	verifyAccessToken.mockResolvedValueOnce({ sub: "demo-user" });

	const response = await fetch(url, { headers: { Authorization: "Bearer demo-token" } });

	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ identityId: "demo-user", roles: [] });

});

it("omits non-string session and client claims from the authenticated identity", async () => {

	verifyAccessToken.mockResolvedValueOnce({ sub: "demo-user", sid: 42, azp: null });

	const response = await fetch(url, { headers: { Authorization: "Bearer demo-token" } });

	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ identityId: "demo-user", roles: [] });

});
