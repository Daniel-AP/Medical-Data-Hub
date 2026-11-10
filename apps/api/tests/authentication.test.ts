import { once } from "node:events";
import { STATUS_CODES } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { JWTPayload } from "jose";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { app, router } from "../src/app.js";
import type { createAccessTokenVerifier } from "../src/clients/keycloak.js";
import { createAuthenticationMiddleware } from "../src/middleware/authentication.js";

const verifyAccessToken = vi.fn<ReturnType<typeof createAccessTokenVerifier>>();
let server: Server;
let url: string;

beforeAll(async () => {

	router.get("/authentication-check", createAuthenticationMiddleware(verifyAccessToken), (request, response) => {
		response.json(request.authentication);
	});

	server = app.listen(0, "127.0.0.1");
	await once(server, "listening");
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/authentication-check`;

});

beforeEach(() => {
	verifyAccessToken.mockReset();
	verifyAccessToken.mockResolvedValue({ sub: "demo-user" });
});

afterAll(async () => {
	server.close();
	await once(server, "close");
});

it("rejects a request without a bearer token with 401", async () => {

	const response = await fetch(url);
	expect(response.status).toBe(401);
	expect(await response.json()).toEqual({ error: STATUS_CODES[401] });
	expect(verifyAccessToken).not.toHaveBeenCalled();

});

it.each(["Basic demo-token", "Bearer", "Bearer token extra"])(
	"rejects a malformed authorization header (%s) with 401",
	async (authorization) => {
		const response = await fetch(url, { headers: { Authorization: authorization } });
		expect(response.status).toBe(401);
		expect(verifyAccessToken).not.toHaveBeenCalled();
	},
);

it.each(["Bearer demo-token", "bEaReR   demo-token"])(
	"authenticates a bearer request (%s) and passes its identity to the route",
	async (authorization) => {

		const response = await fetch(url, { headers: { Authorization: authorization } });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ identityId: "demo-user", roles: [] });
		expect(verifyAccessToken).toHaveBeenCalledWith("demo-token");

	},
);

it("preserves a token verification failure as a generic 401 response", async () => {

	verifyAccessToken.mockRejectedValueOnce(Object.assign(new Error("Invalid access token"), { status: 401 }));
	const response = await fetch(url, { headers: { Authorization: "Bearer demo-token" } });
	expect(response.status).toBe(401);
	expect(await response.json()).toEqual({ error: STATUS_CODES[401] });

});

it("preserves unavailable verification keys as a generic 503 response", async () => {

	verifyAccessToken.mockRejectedValueOnce(Object.assign(new Error("Verification keys unavailable"), { status: 503 }));
	const response = await fetch(url, { headers: { Authorization: "Bearer demo-token" } });
	expect(response.status).toBe(503);
	expect(await response.json()).toEqual({ error: STATUS_CODES[503] });

});

it.each([undefined, null, 42, ""])("rejects an unusable subject (%s) with 401", async (subject) => {

	verifyAccessToken.mockResolvedValueOnce({ sub: subject } as JWTPayload);
	const response = await fetch(url, { headers: { Authorization: "Bearer demo-token" } });
	expect(response.status).toBe(401);
	expect(await response.json()).toEqual({ error: STATUS_CODES[401] });

});

it("preserves unexpected failures as a generic 500 response", async () => {

	verifyAccessToken.mockRejectedValueOnce(new Error("Synthetic internal detail"));
	const response = await fetch(url, { headers: { Authorization: "Bearer demo-token" } });
	expect(response.status).toBe(500);
	expect(await response.json()).toEqual({ error: STATUS_CODES[500] });

});
