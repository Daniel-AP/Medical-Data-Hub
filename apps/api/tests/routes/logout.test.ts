import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { app, router } from "../../src/app.js";
import type { createAccessTokenVerifier, createLogoutIdTokenVerifier } from "../../src/clients/keycloak-tokens.js";
import { createAuthentication } from "../../src/middleware/authentication.js";
import { createLogoutHandler } from "../../src/routes/logout.js";

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
		createAuthentication(verifyAccessToken),
		createLogoutHandler(verifyIdToken, issuer),
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
