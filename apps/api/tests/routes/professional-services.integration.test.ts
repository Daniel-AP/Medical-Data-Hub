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
const unlinkedServiceId = randomUUID();
const fixtureServiceIds = [serviceId, concurrentServiceId, inactiveServiceId, unlinkedServiceId];

const registerProfessionalService = (professionalId: string, body: object, token = administratorToken) => {

	return fetch(new URL(`/professionals/${professionalId}/services`, apiUrl), {
		method: "POST",
		headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(body),
	});

};

const editProfessionalServiceActivity = (professionalId: string, serviceId: string, body: object, token = administratorToken) => {

	return fetch(new URL(`/professionals/${professionalId}/services/${serviceId}`, apiUrl), {
		method: "PATCH",
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
		 JOIN public.professional_services USING (clinic_id, professional_id)
		 JOIN public.services USING (clinic_id, service_id, specialty_id)
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

const readAssociation = async (serviceId: string, targetProfessionalId: string = professionalId) => {

	const { rows } = await setup.query(
		`SELECT clinic_id AS "clinicId", professional_id AS "professionalId",
		        service_id AS "serviceId", is_active AS "isActive"
		 FROM public.professional_services WHERE professional_id = $1::uuid AND service_id = $2::uuid`,
		[targetProfessionalId, serviceId],
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

it("authorizes and validates professional service association activity edits", async () => {

	const body = { isActive: false };
	expect((await editProfessionalServiceActivity(professionalId, serviceId, body, "")).status).toBe(401);
	expect((await editProfessionalServiceActivity(professionalId, serviceId, body, receptionToken)).status).toBe(403);
	expect((await editProfessionalServiceActivity("invalid", serviceId, body)).status).toBe(400);
	expect((await editProfessionalServiceActivity(professionalId, "invalid", body)).status).toBe(400);
	for(const changes of [{}, { isActive: "false" }, { ...body, clinicId: foreignClinic.clinicId }]) {
		expect((await editProfessionalServiceActivity(professionalId, serviceId, changes)).status).toBe(400);
	}

});

it("hides missing and foreign professional service associations during activity edits", async () => {

	for(const [requestedProfessionalId, requestedServiceId] of [
		[professionalId, unlinkedServiceId],
		[foreignClinic.professionalId, foreignClinic.serviceId],
	]) {
		const response = await editProfessionalServiceActivity(requestedProfessionalId, requestedServiceId, { isActive: false });
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Not Found" });
	}

});

it("deactivates and reactivates an association with historical appointments and increments availability only for changes", async () => {

	const { rows: [appointment] } = await setup.query<{
		appointmentId: string; professionalId: string; serviceId: string; state: string;
	}>(
		`SELECT appointment_id AS "appointmentId", professional_id AS "professionalId",
		        service_id AS "serviceId", state
		 FROM public.appointments JOIN public.services USING (clinic_id, service_id)
		 WHERE clinic_id = $1::uuid AND services.name = 'Consulta de seguimiento' LIMIT 1`,
		[clinic.clinicId],
	);
	const { professionalId, serviceId } = appointment;
	const version = await readVersion();
	try {

		const deactivated = await editProfessionalServiceActivity(professionalId, serviceId, { isActive: false });
		expect(deactivated.status).toBe(200);
		expect(await deactivated.json()).toEqual({ professionalId, serviceId, isActive: false });
		expect(await readAssociation(serviceId, professionalId)).toMatchObject([{ isActive: false }]);
		expect(await readVersion()).toBe(version+1n);

		const unchanged = await editProfessionalServiceActivity(professionalId, serviceId, { isActive: false });
		expect(unchanged.status).toBe(200);
		expect(await readVersion()).toBe(version+1n);

		const reactivated = await editProfessionalServiceActivity(professionalId, serviceId, { isActive: true });
		expect(reactivated.status).toBe(200);
		expect(await reactivated.json()).toEqual({ professionalId, serviceId, isActive: true });
		expect(await readAssociation(serviceId, professionalId)).toMatchObject([{ isActive: true }]);
		expect(await readVersion()).toBe(version+2n);

		const { rows } = await setup.query(
			"SELECT state FROM public.appointments WHERE appointment_id = $1::uuid",
			[appointment.appointmentId],
		);
		expect(rows).toEqual([{ state: appointment.state }]);

	} finally {
		await setup.query(
			`UPDATE public.professional_services SET is_active = true
			 WHERE professional_id = $1::uuid AND service_id = $2::uuid`,
			[professionalId, serviceId],
		);
	}

});

it("rejects association deactivation while the pair has reserved appointments", async () => {

	const { rows: [pair] } = await setup.query<{ professionalId: string; serviceId: string }>(
		`SELECT professional_id AS "professionalId", service_id AS "serviceId"
		 FROM public.appointments WHERE clinic_id = $1::uuid AND state = 'reserved' LIMIT 1`,
		[clinic.clinicId],
	);
	const version = await readVersion();
	expect((await editProfessionalServiceActivity(pair.professionalId, pair.serviceId, { isActive: false })).status).toBe(409);
	expect(await readAssociation(pair.serviceId, pair.professionalId)).toMatchObject([{ isActive: true }]);
	expect(await readVersion()).toBe(version);

});

it("rejects reactivation of an association with incompatible specialties", async () => {

	await setup.query(
		`INSERT INTO public.professional_services (clinic_id, professional_id, service_id, is_active)
		 VALUES ($1::uuid, $2::uuid, $3::uuid, false)`,
		[clinic.clinicId, professionalId, incompatibleServiceId],
	);
	const version = await readVersion();
	expect((await editProfessionalServiceActivity(professionalId, incompatibleServiceId, { isActive: true })).status).toBe(409);
	expect(await readAssociation(incompatibleServiceId)).toMatchObject([{ isActive: false }]);
	expect(await readVersion()).toBe(version);

});
