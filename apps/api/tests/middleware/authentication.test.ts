import { once } from "node:events";
import { STATUS_CODES } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { JWTPayload } from "jose";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { app, router } from "../../src/app.js";
import type { createAccessTokenVerifier } from "../../src/clients/keycloak-tokens.js";
import { createAuthentication } from "../../src/middleware/authentication.js";

const verifyAccessToken = vi.fn<ReturnType<typeof createAccessTokenVerifier>>();
let server: Server;
let url: string;

beforeAll(async () => {

	router.get("/authentication-check", createAuthentication(verifyAccessToken), (request, response) => {
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

it.each(["Basic demo-token", "Bearer", "Bearer token extra"])(
	"rejects a malformed authorization header (%s) with 401",
	async (authorization) => {
		const response = await fetch(url, { headers: { Authorization: authorization } });
		expect(response.status).toBe(401);
		expect(verifyAccessToken).not.toHaveBeenCalled();
	},
);

it.each([undefined, null, 42, ""])("rejects an unusable subject (%s) with 401", async (subject) => {

	verifyAccessToken.mockResolvedValueOnce({ sub: subject } as JWTPayload);
	const response = await fetch(url, { headers: { Authorization: "Bearer demo-token" } });
	expect(response.status).toBe(401);
	expect(await response.json()).toEqual({ error: STATUS_CODES[401] });

});
