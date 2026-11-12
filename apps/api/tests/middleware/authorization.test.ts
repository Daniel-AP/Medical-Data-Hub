import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { JWTPayload } from "jose";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { app, router } from "../../src/app.js";
import type { createAccessTokenVerifier } from "../../src/clients/keycloak-tokens.js";
import { UserRole } from "../../src/generated/prisma/enums.js";
import { createAuthentication, requireRoles } from "../../src/middleware/authentication.js";

const verifyAccessToken = vi.fn<ReturnType<typeof createAccessTokenVerifier>>();
const requestOptions = { headers: { Authorization: "Bearer demo-token" } };
let server: Server;
let url: string;

const payloadWithRoles = (roles: string[]): JWTPayload => {
	return { sub: "demo-user", resource_access: { "medical-data-hub-api": { roles } } };
};

beforeAll(async () => {

	const authenticate = createAuthentication(verifyAccessToken);
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

it("rejects realm roles and other client roles as API permissions", async () => {

	verifyAccessToken.mockResolvedValueOnce({
		sub: "demo-user",
		realm_access: { roles: ["clinic_administrator"] },
		resource_access: { "another-client": { roles: ["reception"] } },
	});
	const response = await fetch(`${url}/role-check`, requestOptions);
	expect(response.status).toBe(403);

});
