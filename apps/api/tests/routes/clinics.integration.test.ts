import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { decodeJwt } from "jose";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { app, router } from "../../src/app.js";
import { createAccessTokenVerifier } from "../../src/clients/keycloak/token-verification.js";
import { UserRole } from "../../src/generated/prisma/enums.js";
import { createAuthenticationMiddleware, requireRoles } from "../../src/middleware/authentication.js";
import { createClinicRequestHandler } from "../../src/routes/clinics.js";

type RoleFault = "rejected" | "partial" | "unconfirmed";

const apiUrl = process.env.CLINIC_TEST_API_URL;
const platformToken = process.env.CLINIC_TEST_PLATFORM_TOKEN;
const receptionToken = process.env.CLINIC_TEST_RECEPTION_TOKEN;
const keycloakUrl = process.env.CLINIC_TEST_KEYCLOAK_URL;
const keycloakAdminToken = process.env.CLINIC_TEST_KEYCLOAK_ADMIN_TOKEN;
const setupUrl = process.env.CLINIC_TEST_DATABASE_SETUP_URL;
const applicationId = process.env.KEYCLOAK_CLIENT_ID;
const applicationSecret = process.env.KEYCLOAK_CLIENT_SECRET;
const hasFixtures = apiUrl && platformToken && receptionToken && keycloakUrl && keycloakAdminToken && setupUrl;
if(!hasFixtures || !applicationId || !applicationSecret || !process.env.DATABASE_URL) {
	throw new Error("Set CLINIC_TEST_*, KEYCLOAK_CLIENT_ID, KEYCLOAK_CLIENT_SECRET, and DATABASE_URL for isolated tests");
}

const clinicUrl = new URL("/clinics", apiUrl);
const adminUrl = new URL("/admin/realms/medical-data-hub/", keycloakUrl);
const setup = new Pool({ connectionString: setupUrl });
const timeZone = "America/Costa_Rica";
let faultServer: Server;
let faultUrl: URL;
let roleFault: RoleFault;
const roleMutations: string[] = [];

const fetchWithRoleFault: typeof fetch = async (url, options) => {

	const method = options?.method;
	const isRoleMapping = String(url).includes("/role-mappings/clients/");
	if(!isRoleMapping || (method !== "POST" && method !== "DELETE")) {
		return fetch(url, options);
	}

	roleMutations.push(method);
	if((roleFault === "rejected" && method === "POST") || (roleFault === "partial" && method === "DELETE")) {
		return new Response(null, { status: 403 });
	}

	const response = await fetch(url, options);
	if(roleFault === "unconfirmed" && method === "POST" && response.status === 204) {
		throw new TypeError("Keycloak response was lost");
	}

	return response;

};

const requestClinic = (body: object, token?: string, url = clinicUrl) => {

	return fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(body),
	});

};

const callKeycloakAsAdmin = (path: string, method = "GET", body?: object) => {

	return fetch(new URL(path, adminUrl), {
		method,
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${keycloakAdminToken}` },
		body: body === undefined ? undefined : JSON.stringify(body),
	});

};

const createAdministratorIdentity = async () => {

	const response = await callKeycloakAsAdmin("users", "POST", { username: randomUUID(), enabled: true });
	expect(response.status).toBe(201);

	return new URL(response.headers.get("location")!, adminUrl).pathname.split("/").at(-1)!;

};

const readApplicationRoles = async (identityId: string) => {

	const response = await callKeycloakAsAdmin(`users/${identityId}/role-mappings`);
	expect(response.status).toBe(200);
	const { clientMappings } = await response.json();
	const mappings: { name: string }[] = clientMappings?.[applicationId!]?.mappings ?? [];

	return mappings.map(({ name }) => name).sort();

};

const assignReceptionRole = async (identityId: string) => {

	const response = await callKeycloakAsAdmin(`clients?${new URLSearchParams({ clientId: applicationId! })}`);
	expect(response.status).toBe(200);
	const [{ id: applicationUuid }] = await response.json();
	const role = await callKeycloakAsAdmin(`clients/${applicationUuid}/roles/reception`);
	expect(role.status).toBe(200);
	const assigned = await callKeycloakAsAdmin(
		`users/${identityId}/role-mappings/clients/${applicationUuid}`,
		"POST",
		[await role.json()],
	);
	expect(assigned.status).toBe(204);

};

const removeClinicFixture = async (name: string, identityId: string) => {

	await setup.query("DELETE FROM public.users WHERE identity_id = $1", [identityId]);
	await setup.query(
		`DELETE FROM public.clinic_availability_versions
		 WHERE clinic_id IN (SELECT clinic_id FROM public.clinics WHERE name = $1)`,
		[name],
	);
	await setup.query("DELETE FROM public.clinics WHERE name = $1", [name]);
	await callKeycloakAsAdmin(`users/${identityId}`, "DELETE");

};

beforeAll(async () => {

	const issuer = new URL("/realms/medical-data-hub", keycloakUrl).href;
	const jwksUrl = `${issuer}/protocol/openid-connect/certs`;
	const authenticate = createAuthenticationMiddleware(createAccessTokenVerifier({ issuer, jwksUrl, audience: applicationId }));
	const registerClinic = createClinicRequestHandler({
		issuer: new URL(issuer),
		internalUrl: new URL(keycloakUrl),
		applicationId,
		applicationSecret,
	}, fetchWithRoleFault);
	router.post("/clinics", authenticate, requireRoles(UserRole.platformAdministrator), registerClinic);

	faultServer = app.listen(0, "127.0.0.1");
	await once(faultServer, "listening");
	faultUrl = new URL(`http://127.0.0.1:${(faultServer.address() as AddressInfo).port}/clinics`);

});

afterAll(async () => {

	faultServer.close();
	await once(faultServer, "close");
	await setup.end();

});

it("requires a platform administrator token to register a clinic", async () => {

	const body = { name: "Synthetic clinic", timeZone, administratorIdentityId: randomUUID() };
	expect((await requestClinic(body)).status).toBe(401);
	expect((await requestClinic(body, receptionToken)).status).toBe(403);

});

it("rejects invalid clinic registration fields", async () => {

	const body = { name: "Synthetic clinic", timeZone, administratorIdentityId: randomUUID() };
	expect((await requestClinic({ ...body, name: " " }, platformToken)).status).toBe(400);
	expect((await requestClinic({ ...body, timeZone: "Invalid/Zone" }, platformToken)).status).toBe(400);
	expect((await requestClinic({ ...body, timeZone: "+01:00" }, platformToken)).status).toBe(400);
	expect((await requestClinic({ ...body, administratorIdentityId: "" }, platformToken)).status).toBe(400);

});

it("rejects a clinic registration for a missing Keycloak identity", async () => {

	const response = await requestClinic(
		{ name: "Missing identity clinic", timeZone, administratorIdentityId: randomUUID() },
		platformToken,
	);
	expect(response.status).toBe(404);

});

it("registers a clinic with an active administrator, an initial version, and the Keycloak role", async () => {

	const name = `Synthetic clinic ${randomUUID()}`;
	const administratorIdentityId = await createAdministratorIdentity();

	try {

		await assignReceptionRole(administratorIdentityId);
		const response = await requestClinic({ name, timeZone, administratorIdentityId }, platformToken);
		expect(response.status).toBe(201);
		const result = await response.json();
		expect(result).toEqual({ clinicId: expect.any(String), administratorUserId: expect.any(String) });
		const { rows } = await setup.query(
			`SELECT clinic.name, clinic.time_zone, administrator.identity_id, administrator.role,
			        administrator.is_active, availability.version
			 FROM public.clinics AS clinic
			 JOIN public.users AS administrator USING (clinic_id)
			 JOIN public.clinic_availability_versions AS availability USING (clinic_id)
			 WHERE clinic.clinic_id = $1::uuid AND administrator.user_id = $2::uuid`,
			[result.clinicId, result.administratorUserId],
		);
		expect(rows).toEqual([
			{
				name, time_zone: timeZone, identity_id: administratorIdentityId, role: "clinic_administrator",
				is_active: true, version: "0",
			},
		]);
		expect(await readApplicationRoles(administratorIdentityId)).toEqual(["clinic_administrator"]);

	} finally {
		await removeClinicFixture(name, administratorIdentityId);
	}

});

it("rejects a duplicate administrator identity without persisting a clinic", async () => {

	const name = `Duplicate identity clinic ${randomUUID()}`;
	const administratorIdentityId = decodeJwt(receptionToken).sub;
	const response = await requestClinic({ name, timeZone, administratorIdentityId }, platformToken);
	expect(response.status).toBe(409);
	expect((await setup.query("SELECT clinic_id FROM public.clinics WHERE name = $1", [name])).rows).toEqual([]);
	expect(await readApplicationRoles(administratorIdentityId!)).toEqual(["reception"]);

});

it.each([
	{
		name: "rolls back clinic registration when Keycloak rejects the first role change",
		fault: "rejected",
		code: undefined,
		mutations: ["POST"],
		providerRoles: [],
	},
	{
		name: "reports a partial Keycloak role update and rolls back clinic registration",
		fault: "partial",
		code: "KEYCLOAK_ROLE_UPDATE_PARTIAL",
		mutations: ["POST", "DELETE"],
		providerRoles: ["clinic_administrator", "reception"],
	},
	{
		name: "reports an unconfirmed Keycloak role update and rolls back clinic registration",
		fault: "unconfirmed",
		code: "OPERATION_OUTCOME_UNKNOWN",
		mutations: ["POST"],
		providerRoles: ["clinic_administrator"],
	},
] as const)("$name", async ({ fault, code, mutations, providerRoles }) => {

	const name = `Synthetic clinic ${randomUUID()}`;
	const administratorIdentityId = await createAdministratorIdentity();
	roleFault = fault;
	roleMutations.length = 0;

	try {

		if(fault === "partial") {
			await assignReceptionRole(administratorIdentityId);
		}

		const response = await requestClinic({ name, timeZone, administratorIdentityId }, platformToken, faultUrl);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "Internal Server Error", ...(code ? { code } : {}) });
		expect(roleMutations).toEqual(mutations);
		const { rows } = await setup.query(
			`SELECT EXISTS (SELECT 1 FROM public.clinics WHERE name = $1) AS "clinicExists",
			        EXISTS (SELECT 1 FROM public.users WHERE identity_id = $2) AS "userExists"`,
			[name, administratorIdentityId],
		);
		expect(rows).toEqual([{ clinicExists: false, userExists: false }]);
		expect(await readApplicationRoles(administratorIdentityId)).toEqual(providerRoles);

	} finally {
		await removeClinicFixture(name, administratorIdentityId);
	}

});
