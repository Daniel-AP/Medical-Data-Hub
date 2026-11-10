import { randomUUID } from "node:crypto";
import { decodeJwt } from "jose";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

const apiUrl = process.env.AUDIT_TEST_API_URL;
const administratorToken = process.env.AUDIT_TEST_ADMIN_TOKEN;
const foreignAdministratorToken = process.env.AUDIT_TEST_FOREIGN_ADMIN_TOKEN;
const receptionToken = process.env.AUDIT_TEST_RECEPTION_TOKEN;
const setupUrl = process.env.CLINIC_TEST_DATABASE_SETUP_URL;
if(!apiUrl || !administratorToken || !foreignAdministratorToken || !receptionToken || !setupUrl) {
	throw new Error("Set AUDIT_TEST_API_URL, the three AUDIT_TEST_*_TOKEN variables, and CLINIC_TEST_DATABASE_SETUP_URL");
}

const setup = new Pool({ connectionString: setupUrl });
const serviceUrl = new URL("/services", apiUrl);
const fixtureName = `Synthetic service ${randomUUID()}`;

const registerService = (body: object, token = administratorToken) => {

	return fetch(serviceUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(body),
	});

};

const readClinicSpecialty = async (token: string) => {

	const { rows: [specialty] } = await setup.query<{ clinicId: string; specialtyId: string; version: string }>(
		`SELECT users.clinic_id AS "clinicId", specialties.specialty_id AS "specialtyId", versions.version
		 FROM public.users
		 JOIN public.specialties USING (clinic_id)
		 JOIN public.clinic_availability_versions AS versions USING (clinic_id)
		 WHERE users.identity_id = $1
		 ORDER BY specialties.specialty_id
		 LIMIT 1`,
		[decodeJwt(token).sub],
	);

	return specialty;

};

let localSpecialty: Awaited<ReturnType<typeof readClinicSpecialty>>;
let foreignSpecialty: Awaited<ReturnType<typeof readClinicSpecialty>>;
let registration: { name: string; durationMinutes: number; specialtyId: string };

beforeAll(async () => {
	localSpecialty = await readClinicSpecialty(administratorToken);
	foreignSpecialty = await readClinicSpecialty(foreignAdministratorToken);
	registration = { name: fixtureName, durationMinutes: 30, specialtyId: localSpecialty.specialtyId };
});

afterAll(async () => {
	await setup.query("DELETE FROM public.services WHERE name LIKE $1", [`${fixtureName}%`]);
	await setup.end();
});

it("requires a clinic administrator token to register a service", async () => {
	expect((await registerService(registration, "")).status).toBe(401);
	expect((await registerService(registration, receptionToken)).status).toBe(403);
});

it("rejects invalid service registration fields and clinic overrides", async () => {

	const invalidBodies = [
		{ ...registration, name: " " },
		{ ...registration, name: fixtureName.padEnd(201, "x") },
		{ ...registration, durationMinutes: 0 },
		{ ...registration, durationMinutes: 1.5 },
		{ ...registration, durationMinutes: 2_147_483_648 },
		{ ...registration, durationMinutes: "30" },
		{ ...registration, specialtyId: "invalid" },
		{ ...registration, clinicId: foreignSpecialty.clinicId },
		{ ...registration, isActive: false },
	];
	for(const body of invalidBodies) {
		expect((await registerService(body)).status).toBe(400);
	}

});

it("hides unavailable specialties during service registration", async () => {

	const name = `${fixtureName} unavailable specialty`;
	const missing = await registerService({ ...registration, name, specialtyId: randomUUID() });
	const foreign = await registerService({ ...registration, name, specialtyId: foreignSpecialty.specialtyId });
	expect(missing.status).toBe(404);
	expect(foreign.status).toBe(404);
	expect(await missing.json()).toEqual({ error: "Not Found" });
	expect(await foreign.json()).toEqual({ error: "Not Found" });

});

it("registers an active service in the administrator's clinic without changing the availability version", async () => {

	const response = await registerService(registration);
	expect(response.status).toBe(201);
	const service = await response.json();
	expect(service).toEqual({ serviceId: expect.any(String) });

	const { rows } = await setup.query(
		`SELECT clinic_id AS "clinicId", name, duration_minutes AS "durationMinutes", specialty_id AS "specialtyId",
				is_active AS "isActive"
		 FROM public.services
		 WHERE service_id = $1::uuid`,
		[service.serviceId],
	);
	expect(rows).toEqual([{ clinicId: localSpecialty.clinicId, ...registration, isActive: true }]);
	expect(await readClinicSpecialty(administratorToken)).toEqual(localSpecialty);

});

it("allows only one concurrent registration of the same service name in a clinic", async () => {

	const name = `${fixtureName} concurrent`;
	const responses = await Promise.all([
		registerService({ ...registration, name }),
		registerService({ ...registration, name }),
	]);
	expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
	const { rows } = await setup.query("SELECT service_id FROM public.services WHERE name = $1", [name]);
	expect(rows).toHaveLength(1);

});

it("allows different clinics to register the same service name", async () => {

	const name = `${fixtureName} shared`;
	const local = await registerService({ ...registration, name });
	const foreign = await registerService({ ...registration, name, specialtyId: foreignSpecialty.specialtyId }, foreignAdministratorToken);
	expect(local.status).toBe(201);
	expect(foreign.status).toBe(201);

});

it("distinguishes service names that differ only in case within a clinic", async () => {
	expect((await registerService({ ...registration, name: `${fixtureName} example` })).status).toBe(201);
	expect((await registerService({ ...registration, name: `${fixtureName} Example` })).status).toBe(201);
});
