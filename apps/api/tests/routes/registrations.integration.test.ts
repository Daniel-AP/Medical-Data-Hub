import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { decodeJwt } from "jose";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { app, router } from "../../src/app.js";
import { createAccessTokenVerifier } from "../../src/clients/keycloak/token-verification.js";
import { UserRole } from "../../src/generated/prisma/enums.js";
import { createAuthenticationMiddleware, requireRoles } from "../../src/middleware/authentication.js";
import { createClinicRequestHandler } from "../../src/routes/clinics.js";
import { createUserRequestHandler } from "../../src/routes/users.js";

const apiUrl = process.env.CLINIC_TEST_API_URL;
const platformAdministratorToken = process.env.CLINIC_TEST_PLATFORM_TOKEN;
const clinicAdministratorToken = process.env.USER_TEST_CLINIC_ADMIN_TOKEN;
const receptionToken = process.env.CLINIC_TEST_RECEPTION_TOKEN;
const healthcareProfessionalToken = process.env.USER_TEST_PROFESSIONAL_TOKEN;
const keycloakUrl = process.env.CLINIC_TEST_KEYCLOAK_URL;
const keycloakAdministratorToken = process.env.CLINIC_TEST_KEYCLOAK_ADMIN_TOKEN;
const setupUrl = process.env.CLINIC_TEST_DATABASE_SETUP_URL;
const applicationId = process.env.KEYCLOAK_CLIENT_ID;
const applicationSecret = process.env.KEYCLOAK_CLIENT_SECRET;
const hasTokens = platformAdministratorToken && clinicAdministratorToken && receptionToken &&
	healthcareProfessionalToken && keycloakAdministratorToken;
if(!apiUrl || !hasTokens || !keycloakUrl || !setupUrl || !applicationId || !applicationSecret || !process.env.DATABASE_URL) {
	throw new Error("Set CLINIC_TEST_*, USER_TEST_* role tokens, KEYCLOAK_CLIENT_ID, KEYCLOAK_CLIENT_SECRET, and DATABASE_URL");
}

const setup = new Pool({ connectionString: setupUrl });
const adminUrl = new URL("/admin/realms/medical-data-hub/", keycloakUrl);
const clinicAdministratorIdentityId = decodeJwt(clinicAdministratorToken).sub;
const timeZone = "America/Costa_Rica";
let faultServer: Server;
let faultUrl: string;
let roleFault: "partial" | "rejected" | "unconfirmed";
let fixtureIdentityId: string | undefined;
let fixtureClinicName: string | undefined;
const roleChangeMethods: string[] = [];

const postRegistration = (path: string, body: object, token?: string, baseUrl = apiUrl) => {

	return fetch(new URL(path, baseUrl), {
		method: "POST",
		headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(body),
	});

};

const callKeycloakAsAdmin = (path: string, method = "GET", body?: object) => {

	return fetch(new URL(path, adminUrl), {
		method,
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${keycloakAdministratorToken}` },
		body: body === undefined ? undefined : JSON.stringify(body),
	});

};

const createKeycloakUser = async () => {

	const response = await callKeycloakAsAdmin("users", "POST", { username: randomUUID(), enabled: true });
	expect(response.status).toBe(201);
	fixtureIdentityId = new URL(response.headers.get("location")!, adminUrl).pathname.split("/").at(-1)!;

	return fixtureIdentityId;

};

const readApplicationRoles = async (identityId: string) => {

	const response = await callKeycloakAsAdmin(`users/${identityId}/role-mappings`);
	expect(response.status).toBe(200);
	const { clientMappings } = await response.json();
	const mappings: { name: string }[] = clientMappings?.[applicationId!]?.mappings ?? [];

	return mappings.map(({ name }) => name).sort();

};

const assignReceptionRole = async (identityId: string) => {

	const applications = await callKeycloakAsAdmin(`clients?${new URLSearchParams({ clientId: applicationId! })}`);
	expect(applications.status).toBe(200);
	const [{ id: applicationUuid }] = await applications.json();
	const role = await callKeycloakAsAdmin(`clients/${applicationUuid}/roles/reception`);
	expect(role.status).toBe(200);
	const response = await callKeycloakAsAdmin(
		`users/${identityId}/role-mappings/clients/${applicationUuid}`,
		"POST",
		[await role.json()],
	);
	expect(response.status).toBe(204);

};

const fetchWithRoleFault: typeof fetch = async (url, options) => {

	const method = options?.method;
	const isRoleMapping = String(url).includes("/role-mappings/clients/");
	if(!isRoleMapping || (method !== "POST" && method !== "DELETE")) {
		return fetch(url, options);
	}

	roleChangeMethods.push(method);
	if((roleFault === "rejected" && method === "POST") || (roleFault === "partial" && method === "DELETE")) {
		return new Response(null, { status: 403 });
	}

	const response = await fetch(url, options);
	if(roleFault === "unconfirmed" && method === "POST" && response.status === 204) {
		throw new TypeError("Keycloak response was lost");
	}

	return response;

};

beforeAll(async () => {

	const issuer = new URL("/realms/medical-data-hub", keycloakUrl);
	const jwksUrl = `${issuer}/protocol/openid-connect/certs`;
	const authenticate = createAuthenticationMiddleware(
		createAccessTokenVerifier({ issuer: issuer.href, jwksUrl, audience: applicationId }),
	);
	const settings = { issuer, internalUrl: new URL(keycloakUrl), applicationId, applicationSecret };
	router.post("/clinics", authenticate, requireRoles(UserRole.platformAdministrator), createClinicRequestHandler(settings, fetchWithRoleFault));
	router.post("/users", authenticate, requireRoles(UserRole.clinicAdministrator), createUserRequestHandler(settings, fetchWithRoleFault));

	faultServer = app.listen(0, "127.0.0.1");
	await once(faultServer, "listening");
	faultUrl = `http://127.0.0.1:${(faultServer.address() as AddressInfo).port}`;

});

afterEach(async () => {

	if(fixtureIdentityId) {

		await setup.query("DELETE FROM public.users WHERE identity_id = $1", [fixtureIdentityId]);
		await callKeycloakAsAdmin(`users/${fixtureIdentityId}`, "DELETE");
		fixtureIdentityId = undefined;

	}
	if(fixtureClinicName) {

		await setup.query(
			`DELETE FROM public.clinic_availability_versions
			 WHERE clinic_id IN (SELECT clinic_id FROM public.clinics WHERE name = $1)`,
			[fixtureClinicName],
		);
		await setup.query("DELETE FROM public.clinics WHERE name = $1", [fixtureClinicName]);
		fixtureClinicName = undefined;

	}
	roleChangeMethods.length = 0;

});

afterAll(async () => {

	faultServer.close();
	await once(faultServer, "close");
	await setup.end();

});

it("requires a platform administrator token to register a clinic", async () => {

	const body = { name: "Synthetic clinic", timeZone, administratorIdentityId: randomUUID() };
	expect((await postRegistration("/clinics", body)).status).toBe(401);
	for(const token of [clinicAdministratorToken, receptionToken, healthcareProfessionalToken]) {
		expect((await postRegistration("/clinics", body, token)).status).toBe(403);
	}

});

it("requires a clinic administrator token to register a user", async () => {

	const body = { identityId: randomUUID(), role: "reception" };
	expect((await postRegistration("/users", body)).status).toBe(401);
	for(const token of [platformAdministratorToken, receptionToken, healthcareProfessionalToken]) {
		expect((await postRegistration("/users", body, token)).status).toBe(403);
	}

});

it("rejects invalid clinic registration fields", async () => {

	const body = { name: "Synthetic clinic", timeZone, administratorIdentityId: randomUUID() };
	expect((await postRegistration("/clinics", { ...body, name: " " }, platformAdministratorToken)).status).toBe(400);
	expect((await postRegistration("/clinics", { ...body, timeZone: "Invalid/Zone" }, platformAdministratorToken)).status).toBe(400);
	expect((await postRegistration("/clinics", { ...body, timeZone: "+01:00" }, platformAdministratorToken)).status).toBe(400);

});

it("rejects invalid user registration fields and clinic overrides", async () => {

	const body = { identityId: randomUUID(), role: "reception" };
	expect((await postRegistration("/users", { ...body, identityId: "" }, clinicAdministratorToken)).status).toBe(400);
	expect((await postRegistration("/users", { ...body, role: "platform_administrator" }, clinicAdministratorToken)).status).toBe(400);
	expect((await postRegistration("/users", { ...body, clinicId: randomUUID() }, clinicAdministratorToken)).status).toBe(400);

});

it("rejects missing Keycloak identities in both registrations", async () => {

	const identityId = randomUUID();
	const clinicBody = { name: "Synthetic clinic", timeZone, administratorIdentityId: identityId };
	const userBody = { identityId, role: "reception" };
	expect((await postRegistration("/clinics", clinicBody, platformAdministratorToken)).status).toBe(404);
	expect((await postRegistration("/users", userBody, clinicAdministratorToken)).status).toBe(404);

});

it("registers a clinic with an active administrator, an initial version, and the Keycloak role", async () => {

	const name = `Synthetic clinic ${randomUUID()}`;
	fixtureClinicName = name;
	const administratorIdentityId = await createKeycloakUser();
	await assignReceptionRole(administratorIdentityId);
	const response = await postRegistration("/clinics", { name, timeZone, administratorIdentityId }, platformAdministratorToken);
	expect(response.status).toBe(201);
	const result = await response.json();
	expect(result).toEqual({ clinicId: expect.any(String), administratorUserId: expect.any(String) });
	const { rows } = await setup.query(
		`SELECT clinic.name, clinic.time_zone, administrator.identity_id, administrator.role,
		        administrator.is_active, availability.version
		 FROM public.clinics AS clinic
		 JOIN public.users AS administrator USING (clinic_id)
		 JOIN public.clinic_availability_versions AS availability USING (clinic_id)
		 WHERE clinic.clinic_id = $1 AND administrator.user_id = $2`,
		[result.clinicId, result.administratorUserId],
	);
	expect(rows).toEqual([
		{ name, time_zone: timeZone, identity_id: administratorIdentityId, role: "clinic_administrator", is_active: true, version: "0" },
	]);
	expect(await readApplicationRoles(administratorIdentityId)).toEqual(["clinic_administrator"]);

});

it("registers an active user in the administrator's clinic and assigns the Keycloak role", async () => {

	const identityId = await createKeycloakUser();
	const response = await postRegistration("/users", { identityId, role: "healthcare_professional" }, clinicAdministratorToken);
	expect(response.status).toBe(201);
	const result = await response.json();
	expect(result).toEqual({ userId: expect.any(String) });
	const { rows } = await setup.query(
		`SELECT registered.user_id AS "userId", registered.role, registered.is_active AS "isActive",
		        registered.clinic_id = administrator.clinic_id AS "sameClinic",
		        EXISTS (SELECT 1 FROM public.professionals WHERE user_id = registered.user_id) AS "hasProfile"
		 FROM public.users AS registered
		 JOIN public.users AS administrator ON administrator.identity_id = $2
		 WHERE registered.identity_id = $1`,
		[identityId, clinicAdministratorIdentityId],
	);
	expect(rows).toEqual([
		{ userId: result.userId, role: "healthcare_professional", isActive: true, sameClinic: true, hasProfile: false },
	]);
	expect(await readApplicationRoles(identityId)).toEqual(["healthcare_professional"]);

});

it("rejects a duplicate identity in both registrations without changing its clinic or role", async () => {

	const { rows: [existingUser] } = await setup.query(
		`SELECT existing.identity_id AS "identityId", existing.clinic_id AS "clinicId", existing.role
		 FROM public.users AS existing
		 JOIN public.users AS administrator ON administrator.identity_id = $1
		 WHERE existing.clinic_id <> administrator.clinic_id AND existing.role = 'reception'
		 ORDER BY existing.user_id LIMIT 1`,
		[clinicAdministratorIdentityId],
	);
	const { identityId } = existingUser;
	const name = `Duplicate identity clinic ${randomUUID()}`;
	fixtureClinicName = name;
	const clinicBody = { name, timeZone, administratorIdentityId: identityId };
	const userBody = { identityId, role: "clinic_administrator" };
	const clinicResponse = await postRegistration("/clinics", clinicBody, platformAdministratorToken);
	expect(clinicResponse.status).toBe(409);
	const userResponse = await postRegistration("/users", userBody, clinicAdministratorToken);
	expect(userResponse.status).toBe(409);
	expect(await userResponse.json()).toEqual({ error: "Conflict" });
	expect((await setup.query("SELECT clinic_id FROM public.clinics WHERE name = $1", [name])).rows).toEqual([]);
	const { rows } = await setup.query(
		'SELECT identity_id AS "identityId", clinic_id AS "clinicId", role FROM public.users WHERE identity_id = $1',
		[identityId],
	);
	expect(rows).toEqual([existingUser]);
	expect(await readApplicationRoles(identityId)).toEqual(["reception"]);

});

it("reports a partial Keycloak role update and rolls back clinic registration", async () => {

	const name = `Synthetic clinic ${randomUUID()}`;
	fixtureClinicName = name;
	const administratorIdentityId = await createKeycloakUser();
	await assignReceptionRole(administratorIdentityId);
	roleFault = "partial";

	const body = { name, timeZone, administratorIdentityId };
	const response = await postRegistration("/clinics", body, platformAdministratorToken, faultUrl);
	expect(response.status).toBe(500);
	expect(await response.json()).toMatchObject({ code: "KEYCLOAK_ROLE_UPDATE_PARTIAL" });
	expect(roleChangeMethods).toEqual(["POST", "DELETE"]);
	expect((await setup.query("SELECT clinic_id FROM public.clinics WHERE name = $1", [name])).rows).toEqual([]);
	expect((await setup.query("SELECT user_id FROM public.users WHERE identity_id = $1", [administratorIdentityId])).rows).toEqual([]);
	expect(await readApplicationRoles(administratorIdentityId)).toEqual(["clinic_administrator", "reception"]);

});

it.each([
	{
		name: "rolls back user registration when Keycloak rejects the role assignment",
		fault: "rejected",
		expectedBody: { error: "Internal Server Error" },
		expectedRoles: [],
	},
	{
		name: "reports an unconfirmed role assignment and rolls back user registration",
		fault: "unconfirmed",
		expectedBody: { error: "Internal Server Error", code: "OPERATION_OUTCOME_UNKNOWN" },
		expectedRoles: ["reception"],
	},
] as const)("$name", async ({ fault, expectedBody, expectedRoles }) => {

	const identityId = await createKeycloakUser();
	roleFault = fault;
	const response = await postRegistration("/users", { identityId, role: "reception" }, clinicAdministratorToken, faultUrl);
	expect(response.status).toBe(500);
	expect(await response.json()).toEqual(expectedBody);
	expect(roleChangeMethods).toEqual(["POST"]);
	expect((await setup.query("SELECT user_id FROM public.users WHERE identity_id = $1", [identityId])).rows).toEqual([]);
	expect(await readApplicationRoles(identityId)).toEqual(expectedRoles);

});
