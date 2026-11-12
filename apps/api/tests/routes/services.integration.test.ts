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

const editService = (serviceId: string, body: object, token = administratorToken) => {

	return fetch(new URL(`/services/${serviceId}`, serviceUrl), {
		method: "PATCH",
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

const createServiceFixture = async (suffix: string) => {

	const response = await registerService({ ...registration, name: `${fixtureName} ${suffix}` });
	expect(response.status).toBe(201);
	const { serviceId } = await response.json() as { serviceId: string };

	return serviceId;

};

const readVersion = async () => {
	return BigInt((await readClinicSpecialty(administratorToken)).version);
};

const readSeedService = async (name: string) => {

	const { rows: [service] } = await setup.query<{ serviceId: string; durationMinutes: number; isActive: boolean }>(
		`SELECT service_id AS "serviceId", duration_minutes AS "durationMinutes", is_active AS "isActive"
		 FROM public.services WHERE clinic_id = $1::uuid AND name = $2`,
		[localSpecialty.clinicId, name],
	);

	return service;

};

it("authorizes and validates service edits within the administrator's clinic", async () => {

	const serviceId = await createServiceFixture("edit scope");
	const changes = { isActive: false };
	expect((await editService(serviceId, changes, "")).status).toBe(401);
	expect((await editService(serviceId, changes, receptionToken)).status).toBe(403);
	expect((await editService("invalid", changes)).status).toBe(400);
	for(const body of [{}, { durationMinutes: 0 }, { isActive: "false" }, { name: null }, { clinicId: foreignSpecialty.clinicId }]) {
		expect((await editService(serviceId, body)).status).toBe(400);
	}

	const missing = await editService(randomUUID(), changes);
	const foreign = await editService(serviceId, changes, foreignAdministratorToken);
	expect(missing.status).toBe(404);
	expect(foreign.status).toBe(404);
	expect(await foreign.json()).toEqual(await missing.json());

});

it("preserves concurrent partial edits to different service fields", async () => {

	const serviceId = await createServiceFixture("concurrent edits");
	const version = await readVersion();
	const name = `${fixtureName} renamed`;
	const responses = await Promise.all([
		editService(serviceId, { name }),
		editService(serviceId, { durationMinutes: 45 }),
	]);
	expect(responses.map(({ status }) => status)).toEqual([200, 200]);

	const response = await editService(serviceId, { name });
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ ...registration, serviceId, name, durationMinutes: 45, isActive: true });
	expect(await readVersion()).toBe(version+1n);

});

it("increments availability once for combined duration and specialty changes and skips unchanged values", async () => {

	const serviceId = await createServiceFixture("combined edit");
	const { rows: [specialty] } = await setup.query<{ specialtyId: string }>(
		`SELECT specialty_id AS "specialtyId" FROM public.specialties
		 WHERE clinic_id = $1::uuid AND specialty_id <> $2::uuid`,
		[localSpecialty.clinicId, registration.specialtyId],
	);
	const version = await readVersion();
	const changes = { durationMinutes: 45, specialtyId: specialty.specialtyId };
	const updated = await editService(serviceId, changes);
	expect(updated.status).toBe(200);
	expect(await updated.json()).toEqual({ serviceId, name: `${fixtureName} combined edit`, ...changes, isActive: true });
	expect(await readVersion()).toBe(version+1n);

	const unchanged = await editService(serviceId, { ...changes, specialtyId: changes.specialtyId.toUpperCase() });
	expect(unchanged.status).toBe(200);
	expect(await readVersion()).toBe(version+1n);

});

it("rejects duplicate names and foreign specialties during service edits", async () => {

	const serviceId = await createServiceFixture("edit conflicts");
	const version = await readVersion();
	expect((await editService(serviceId, { name: "Consulta general" })).status).toBe(409);
	const foreign = await editService(serviceId, { specialtyId: foreignSpecialty.specialtyId });
	expect(foreign.status).toBe(404);
	expect(await foreign.json()).toEqual({ error: "Not Found" });
	expect(await readVersion()).toBe(version);

});

it("blocks changes to service duration and specialty after historical appointments", async () => {

	const service = await readSeedService("Consulta de seguimiento");
	const { rows } = await setup.query<{ state: string }>(
		"SELECT state FROM public.appointments WHERE service_id = $1::uuid",
		[service.serviceId],
	);
	expect(rows.length).toBeGreaterThan(0);
	expect(rows.every(({ state }) => state !== "reserved")).toBe(true);
	expect((await editService(service.serviceId, { durationMinutes: service.durationMinutes+1 })).status).toBe(409);

	const { rows: [specialty] } = await setup.query<{ specialtyId: string }>(
		`SELECT specialty_id AS "specialtyId" FROM public.specialties
		 WHERE clinic_id = $1::uuid AND name = 'Fisioterapia'`,
		[localSpecialty.clinicId],
	);
	expect((await editService(service.serviceId, { specialtyId: specialty.specialtyId })).status).toBe(409);

});

it("blocks a service specialty change while its association is active", async () => {

	const serviceId = await createServiceFixture("associated");
	const { rows: [professional] } = await setup.query<{ professionalId: string }>(
		`INSERT INTO public.professional_services (clinic_id, professional_id, service_id)
		 SELECT clinic_id, professional_id, $1::uuid FROM public.professionals
		 WHERE clinic_id = $2::uuid AND specialty_id = $3::uuid LIMIT 1
		 RETURNING professional_id AS "professionalId"`,
		[serviceId, localSpecialty.clinicId, registration.specialtyId],
	);
	try {

		const { rows: [specialty] } = await setup.query<{ specialtyId: string }>(
			`SELECT specialty_id AS "specialtyId" FROM public.specialties
			 WHERE clinic_id = $1::uuid AND specialty_id <> $2::uuid`,
			[localSpecialty.clinicId, registration.specialtyId],
		);
		expect((await editService(serviceId, { specialtyId: specialty.specialtyId })).status).toBe(409);

	} finally {
		await setup.query("DELETE FROM public.professional_services WHERE service_id = $1::uuid AND professional_id = $2::uuid",
			[serviceId, professional.professionalId]);
	}

});

it("deactivates a service while preserving its reservations and active associations", async () => {

	const service = await readSeedService("Consulta general");
	const version = await readVersion();
	const readReferences = async () => {

		const { rows: [references] } = await setup.query<{ reservations: string[]; associations: string[] }>(
			`SELECT ARRAY(SELECT appointment_id FROM public.appointments
			              WHERE service_id = $1::uuid AND state = 'reserved' ORDER BY appointment_id) AS reservations,
			        ARRAY(SELECT professional_id FROM public.professional_services
			              WHERE service_id = $1::uuid AND is_active ORDER BY professional_id) AS associations`,
			[service.serviceId],
		);

		return references;

	};
	const references = await readReferences();
	expect(references.reservations.length).toBeGreaterThan(0);
	expect(references.associations.length).toBeGreaterThan(0);
	try {

		const response = await editService(service.serviceId, { isActive: false });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ serviceId: service.serviceId, isActive: false });
		expect(await readReferences()).toEqual(references);
		expect(await readVersion()).toBe(version);

	} finally {
		await setup.query("UPDATE public.services SET is_active = $2 WHERE service_id = $1::uuid", [service.serviceId, service.isActive]);
	}

});
