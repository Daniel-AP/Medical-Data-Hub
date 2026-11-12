import { randomUUID } from "node:crypto";
import { decodeJwt } from "jose";
import { Pool } from "pg";
import { afterAll, expect, it } from "vitest";

const apiUrl = process.env.AUDIT_TEST_API_URL;
const administratorToken = process.env.AUDIT_TEST_ADMIN_TOKEN;
const foreignAdministratorToken = process.env.AUDIT_TEST_FOREIGN_ADMIN_TOKEN;
const receptionToken = process.env.AUDIT_TEST_RECEPTION_TOKEN;
const setupUrl = process.env.CLINIC_TEST_DATABASE_SETUP_URL;
if(!apiUrl || !administratorToken || !foreignAdministratorToken || !receptionToken || !setupUrl) {
	throw new Error("Set AUDIT_TEST_API_URL, the three AUDIT_TEST_*_TOKEN variables, and CLINIC_TEST_DATABASE_SETUP_URL");
}

const setup = new Pool({ connectionString: setupUrl });
const specialtyUrl = new URL("/specialties", apiUrl);
const administratorIdentityId = decodeJwt(administratorToken).sub;
const fixtureId = randomUUID();
const specialtyName = ` Synthetic specialty ${fixtureId} `;
const concurrentName = `Concurrent specialty ${fixtureId}`;
const sharedName = `Shared specialty ${fixtureId}`;
const caseName = `Case-sensitive specialty ${fixtureId}`;

const registerSpecialty = (body: object, token = administratorToken) => {

	return fetch(specialtyUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(body),
	});

};

const readAdministratorClinic = async () => {

	const { rows: [clinic] } = await setup.query<{ clinicId: string; version: string }>(
		`SELECT users.clinic_id AS "clinicId", versions.version
		 FROM public.users
		 JOIN public.clinic_availability_versions AS versions USING (clinic_id)
		 WHERE users.identity_id = $1`,
		[administratorIdentityId],
	);

	return clinic;

};

afterAll(async () => {

	await setup.query(
		"DELETE FROM public.specialties WHERE name = ANY($1::text[])",
		[[specialtyName, concurrentName, sharedName, caseName, caseName.toUpperCase()]],
	);
	await setup.end();

});

it("requires a clinic administrator token to register a specialty", async () => {
	expect((await registerSpecialty({ name: specialtyName }, "")).status).toBe(401);
	expect((await registerSpecialty({ name: specialtyName }, receptionToken)).status).toBe(403);
});

it("rejects invalid specialty names and clinic overrides", async () => {

	const invalidBodies = [
		{},
		{ name: 42 },
		{ name: " " },
		{ name: "a".repeat(101) },
		{ name: "a\0b" },
		{ name: specialtyName, clinicId: randomUUID() },
	];
	for(const body of invalidBodies) {
		expect((await registerSpecialty(body)).status).toBe(400);
	}

});

it("registers a specialty in the administrator's clinic without changing the availability version", async () => {

	const clinic = await readAdministratorClinic();
	const response = await registerSpecialty({ name: specialtyName });
	expect(response.status).toBe(201);
	const specialty = await response.json();
	expect(specialty).toEqual({ specialtyId: expect.any(String) });

	const { rows } = await setup.query(
		`SELECT clinic_id AS "clinicId", name FROM public.specialties WHERE specialty_id = $1::uuid`,
		[specialty.specialtyId],
	);
	expect(rows).toEqual([{ clinicId: clinic.clinicId, name: specialtyName }]);
	expect(await readAdministratorClinic()).toEqual(clinic);

});

it("allows only one concurrent registration of the same specialty name in a clinic", async () => {

	const responses = await Promise.all([
		registerSpecialty({ name: concurrentName }),
		registerSpecialty({ name: concurrentName }),
	]);
	expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
	const { rows } = await setup.query("SELECT specialty_id FROM public.specialties WHERE name = $1", [concurrentName]);
	expect(rows).toHaveLength(1);

});
