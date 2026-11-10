import { once } from "node:events";
import { STATUS_CODES } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { JWTPayload } from "jose";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { app, router } from "../../src/app.js";
import type { createAccessTokenVerifier } from "../../src/clients/keycloak/token-verification.js";
import { UserRole } from "../../src/generated/prisma/enums.js";
import { createAuthenticationMiddleware, requireRoles } from "../../src/middleware/authentication.js";

const verifyAccessToken = vi.fn<ReturnType<typeof createAccessTokenVerifier>>();
const requestOptions = { headers: { Authorization: "Bearer demo-token" } };
let server: Server;
let url: string;

const payloadWithRoles = (roles: string[]): JWTPayload => {
	return { sub: "demo-user", resource_access: { "medical-data-hub-api": { roles } } };
};

beforeAll(async () => {

	const authenticate = createAuthenticationMiddleware(verifyAccessToken);
	router.get("/role-mapping-check", authenticate, (request, response) => {
		response.json(request.authentication);
	});
	router.get(
		"/role-check",
		authenticate,
		requireRoles(UserRole.clinicAdministrator, UserRole.reception),
		(_request, response) => {
			response.sendStatus(204);
		},
	);
	router.get("/role-without-authentication-check", requireRoles(UserRole.reception), (_request, response) => {
		response.sendStatus(204);
	});

	server = app.listen(0, "127.0.0.1");
	await once(server, "listening");
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

});

beforeEach(() => {
	verifyAccessToken.mockReset();
	verifyAccessToken.mockResolvedValue({ sub: "demo-user" });
});

afterAll(async () => {
	server.close();
	await once(server, "close");
});

it.each([
	["platform_administrator", UserRole.platformAdministrator],
	["clinic_administrator", UserRole.clinicAdministrator],
	["reception", UserRole.reception],
	["healthcare_professional", UserRole.healthcareProfessional],
] as const)("maps the API role %s to its domain role", async (tokenRole, domainRole) => {

	verifyAccessToken.mockResolvedValueOnce(payloadWithRoles([tokenRole]));
	const response = await fetch(`${url}/role-mapping-check`, requestOptions);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ identityId: "demo-user", roles: [domainRole] });

});

it("retains recognized API roles and ignores unknown roles", async () => {

	verifyAccessToken.mockResolvedValueOnce(payloadWithRoles(["reception", "unknown_role", "clinic_administrator"]));
	const response = await fetch(`${url}/role-mapping-check`, requestOptions);
	expect(response.status).toBe(200);
	const authentication = await response.json();
	expect(authentication.roles).toEqual(expect.arrayContaining([UserRole.reception, UserRole.clinicAdministrator]));
	expect(authentication.roles).toHaveLength(2);

});

it.each(["clinic_administrator", "reception"])("accepts an allowed token role (%s)", async (role) => {
	verifyAccessToken.mockResolvedValueOnce(payloadWithRoles([role]));
	const response = await fetch(`${url}/role-check`, requestOptions);
	expect(response.status).toBe(204);
});

it.each(["platform_administrator", "healthcare_professional"])(
	"rejects an insufficient token role (%s) with 403",
	async (role) => {

		verifyAccessToken.mockResolvedValueOnce(payloadWithRoles([role]));
		const response = await fetch(`${url}/role-check`, requestOptions);
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: STATUS_CODES[403] });

	},
);

it("accepts a token containing at least one allowed role", async () => {
	verifyAccessToken.mockResolvedValueOnce(payloadWithRoles(["healthcare_professional", "reception"]));
	const response = await fetch(`${url}/role-check`, requestOptions);
	expect(response.status).toBe(204);
});

it("rejects missing token roles with 403", async () => {
	const response = await fetch(`${url}/role-check`, requestOptions);
	expect(response.status).toBe(403);
});

it("rejects realm roles and other client roles as API permissions", async () => {

	verifyAccessToken.mockResolvedValueOnce({
		sub: "demo-user",
		realm_access: { roles: ["clinic_administrator"] },
		resource_access: { "another-client": { roles: ["reception"] } },
	});
	const response = await fetch(`${url}/role-check`, requestOptions);
	expect(response.status).toBe(403);

});

it("rejects unknown API roles with 403", async () => {
	verifyAccessToken.mockResolvedValueOnce(payloadWithRoles(["unknown_role"]));
	const response = await fetch(`${url}/role-check`, requestOptions);
	expect(response.status).toBe(403);
});

it.each([
	["null resource access", { resource_access: null }],
	["invalid resource access", { resource_access: "invalid" }],
	["null client access", { resource_access: { "medical-data-hub-api": null } }],
	["invalid role list", { resource_access: { "medical-data-hub-api": { roles: "reception" } } }],
] as const)("rejects %s as API permissions with 403", async (_case, payload) => {
	verifyAccessToken.mockResolvedValueOnce({ sub: "demo-user", ...payload });
	const response = await fetch(`${url}/role-check`, requestOptions);
	expect(response.status).toBe(403);
});

it("rejects role checks without authentication with 401", async () => {
	const response = await fetch(`${url}/role-without-authentication-check`, requestOptions);
	expect(response.status).toBe(401);
	expect(verifyAccessToken).not.toHaveBeenCalled();
});
