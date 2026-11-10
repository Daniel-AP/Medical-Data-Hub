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
const userId = randomUUID();
const professionalId = randomUUID();
const serviceId = randomUUID();
const concurrentServiceId = randomUUID();
const inactiveServiceId = randomUUID();
const fixtureServiceIds = [serviceId, concurrentServiceId, inactiveServiceId];

const registerProfessionalService = (professionalId: string, body: object, token = administratorToken) => {

	return fetch(new URL(`/professionals/${professionalId}/services`, apiUrl), {
		method: "POST",
		headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(body),
	});

};

const readClinic = async (token: string) => {

	const { rows: [clinic] } = await setup.query<{
		clinicId: string; professionalId: string; serviceId: string; specialtyId: string;
	}>(
		`SELECT users.clinic_id AS "clinicId", professionals.professional_id AS "professionalId",
		        services.service_id AS "serviceId", professionals.specialty_id AS "specialtyId"
		 FROM public.users
		 JOIN public.professionals USING (clinic_id)
		 JOIN public.services USING (clinic_id, specialty_id)
		 WHERE users.identity_id = $1 LIMIT 1`,
		[decodeJwt(token).sub],
	);

	return clinic;

};

let clinic: Awaited<ReturnType<typeof readClinic>>;
let foreignClinic: Awaited<ReturnType<typeof readClinic>>;
let incompatibleServiceId: string;

const readVersion = async () => {

	const { rows: [version] } = await setup.query<{ version: string }>(
		"SELECT version FROM public.clinic_availability_versions WHERE clinic_id = $1::uuid",
		[clinic.clinicId],
	);

	return BigInt(version.version);

};

const readAssociation = async (serviceId: string) => {

	const { rows } = await setup.query(
		`SELECT clinic_id AS "clinicId", professional_id AS "professionalId",
		        service_id AS "serviceId", is_active AS "isActive"
		 FROM public.professional_services WHERE professional_id = $1::uuid AND service_id = $2::uuid`,
		[professionalId, serviceId],
	);

	return rows;

};

beforeAll(async () => {

	clinic = await readClinic(administratorToken);
	foreignClinic = await readClinic(foreignAdministratorToken);
	const { rows: [incompatibleService] } = await setup.query<{ serviceId: string }>(
		`SELECT service_id AS "serviceId" FROM public.services
		 WHERE clinic_id = $1::uuid AND specialty_id <> $2::uuid LIMIT 1`,
		[clinic.clinicId, clinic.specialtyId],
	);
	incompatibleServiceId = incompatibleService.serviceId;

	await setup.query(
		`INSERT INTO public.users (user_id, identity_id, clinic_id, role, is_active)
		 VALUES ($1::uuid, $2, $3::uuid, 'healthcare_professional', false)`,
		[userId, `synthetic-association-${userId}`, clinic.clinicId],
	);
	await setup.query(
		`INSERT INTO public.professionals (professional_id, clinic_id, user_id, specialty_id)
		 VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
		[professionalId, clinic.clinicId, userId, clinic.specialtyId],
	);
	for(const serviceId of fixtureServiceIds) {
		await setup.query(
			`INSERT INTO public.services (service_id, clinic_id, name, duration_minutes, specialty_id)
			 VALUES ($1::uuid, $2::uuid, $3, 30, $4::uuid)`,
			[serviceId, clinic.clinicId, `Synthetic association service ${serviceId}`, clinic.specialtyId],
		);
	}

});

afterAll(async () => {

	await setup.query("DELETE FROM public.professional_services WHERE professional_id = $1::uuid", [professionalId]);
	await setup.query("DELETE FROM public.services WHERE service_id = ANY($1::uuid[])", [fixtureServiceIds]);
	await setup.query("DELETE FROM public.professionals WHERE professional_id = $1::uuid", [professionalId]);
	await setup.query("DELETE FROM public.users WHERE user_id = $1::uuid", [userId]);
	await setup.end();

});

it("requires a clinic administrator token to register a professional service association", async () => {
	expect((await registerProfessionalService(professionalId, { serviceId }, "")).status).toBe(401);
	expect((await registerProfessionalService(professionalId, { serviceId }, receptionToken)).status).toBe(403);
});

it("rejects invalid professional service association fields and clinic overrides", async () => {

	expect((await registerProfessionalService("invalid", { serviceId })).status).toBe(400);
	for(const body of [{}, { serviceId: "invalid" }, { serviceId, clinicId: foreignClinic.clinicId }]) {
		expect((await registerProfessionalService(professionalId, body)).status).toBe(400);
	}

});

it("hides unavailable professionals and services during association registration", async () => {

	for(const [requestedProfessionalId, requestedServiceId] of [
		[randomUUID(), serviceId],
		[foreignClinic.professionalId, serviceId],
		[professionalId, randomUUID()],
		[professionalId, foreignClinic.serviceId],
	]) {
		const response = await registerProfessionalService(requestedProfessionalId, { serviceId: requestedServiceId });
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Not Found" });
	}

});

it("rejects a professional service association with incompatible specialties", async () => {

	const version = await readVersion();
	const response = await registerProfessionalService(professionalId, { serviceId: incompatibleServiceId });
	expect(response.status).toBe(409);
	expect(await readAssociation(incompatibleServiceId)).toEqual([]);
	expect(await readVersion()).toBe(version);

});

it("registers an active association and increments availability for a professional with an inactive user", async () => {

	const version = await readVersion();
	const response = await registerProfessionalService(professionalId, { serviceId });
	expect(response.status).toBe(201);
	expect(await response.json()).toEqual({ professionalId, serviceId });
	expect(await readAssociation(serviceId)).toEqual([{ clinicId: clinic.clinicId, professionalId, serviceId, isActive: true }]);
	expect(await readVersion()).toBe(version+1n);

});

it("allows only one concurrent registration of a professional service association", async () => {

	const version = await readVersion();
	const body = { serviceId: concurrentServiceId };
	const responses = await Promise.all([
		registerProfessionalService(professionalId, body),
		registerProfessionalService(professionalId, body),
	]);
	expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
	expect(await readAssociation(concurrentServiceId)).toHaveLength(1);
	expect(await readVersion()).toBe(version+1n);

});

it("preserves an existing inactive association when registration is retried", async () => {

	await setup.query(
		`INSERT INTO public.professional_services (clinic_id, professional_id, service_id, is_active)
		 VALUES ($1::uuid, $2::uuid, $3::uuid, false)`,
		[clinic.clinicId, professionalId, inactiveServiceId],
	);
	const version = await readVersion();
	expect((await registerProfessionalService(professionalId, { serviceId: inactiveServiceId })).status).toBe(409);
	expect(await readAssociation(inactiveServiceId)).toEqual([{
		clinicId: clinic.clinicId, professionalId, serviceId: inactiveServiceId, isActive: false,
	}]);
	expect(await readVersion()).toBe(version);

});
