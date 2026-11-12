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
const professionalUrl = new URL("/professionals", apiUrl);
const inactiveUserId = randomUUID();
const concurrentUserId = randomUUID();
const unassignedUserId = randomUUID();
const editableUserId = randomUUID();
const fixtureUserIds = [inactiveUserId, concurrentUserId, unassignedUserId, editableUserId];

const registerProfessional = (body: object, token = administratorToken) => {

	return fetch(professionalUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(body),
	});

};

const editProfessionalSpecialty = (professionalId: string, body: object, token = administratorToken) => {

	return fetch(new URL(`/professionals/${professionalId}`, professionalUrl), {
		method: "PATCH",
		headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(body),
	});

};

const readClinic = async (token: string) => {

	const { rows: [clinic] } = await setup.query<{
		clinicId: string; userId: string; specialtyId: string; professionalId: string; version: string;
	}>(
		`SELECT users.clinic_id AS "clinicId", users.user_id AS "userId",
		        specialties.specialty_id AS "specialtyId", professionals.professional_id AS "professionalId", versions.version
		 FROM public.users
		 JOIN public.specialties USING (clinic_id)
		 JOIN public.professionals USING (clinic_id, specialty_id)
		 JOIN public.clinic_availability_versions AS versions USING (clinic_id)
		 WHERE users.identity_id = $1 ORDER BY specialties.specialty_id LIMIT 1`,
		[decodeJwt(token).sub],
	);

	return clinic;

};

let clinic: Awaited<ReturnType<typeof readClinic>>;
let foreignClinic: Awaited<ReturnType<typeof readClinic>>;
let editableProfessionalId: string;
let nextSpecialtyId: string;

beforeAll(async () => {

	clinic = await readClinic(administratorToken);
	foreignClinic = await readClinic(foreignAdministratorToken);
	for(const userId of fixtureUserIds) {
		await setup.query(
			`INSERT INTO public.users (user_id, identity_id, clinic_id, role, is_active)
			 VALUES ($1::uuid, $2, $3::uuid, 'healthcare_professional', $4)`,
			[userId, `synthetic-professional-${userId}`, clinic.clinicId, userId !== inactiveUserId],
		);
	}

	const { rows: [professional] } = await setup.query<{ professionalId: string }>(
		`INSERT INTO public.professionals (clinic_id, user_id, specialty_id) VALUES ($1::uuid, $2::uuid, $3::uuid)
		 RETURNING professional_id AS "professionalId"`,
		[clinic.clinicId, editableUserId, clinic.specialtyId],
	);
	const { rows: [specialty] } = await setup.query<{ specialtyId: string }>(
		`SELECT specialty_id AS "specialtyId" FROM public.specialties
		 WHERE clinic_id = $1::uuid AND specialty_id <> $2::uuid LIMIT 1`,
		[clinic.clinicId, clinic.specialtyId],
	);
	editableProfessionalId = professional.professionalId;
	nextSpecialtyId = specialty.specialtyId;

});

afterAll(async () => {

	await setup.query("DELETE FROM public.professional_services WHERE professional_id = $1::uuid", [editableProfessionalId]);
	await setup.query("DELETE FROM public.professionals WHERE user_id = ANY($1::uuid[])", [fixtureUserIds]);
	await setup.query("DELETE FROM public.users WHERE user_id = ANY($1::uuid[])", [fixtureUserIds]);
	await setup.end();

});

it("requires a clinic administrator token to register a professional", async () => {
	const body = { userId: unassignedUserId, specialtyId: clinic.specialtyId };
	expect((await registerProfessional(body, "")).status).toBe(401);
	expect((await registerProfessional(body, receptionToken)).status).toBe(403);
});

it("rejects invalid professional registration fields and clinic overrides", async () => {

	for(const body of [
		{ userId: unassignedUserId },
		{ userId: "invalid", specialtyId: clinic.specialtyId },
		{ userId: unassignedUserId, specialtyId: clinic.specialtyId, clinicId: foreignClinic.clinicId },
	]) {
		expect((await registerProfessional(body)).status).toBe(400);
	}

});

it("hides unavailable users and specialties during professional registration", async () => {

	for(const body of [
		{ userId: randomUUID(), specialtyId: clinic.specialtyId },
		{ userId: foreignClinic.userId, specialtyId: clinic.specialtyId },
		{ userId: unassignedUserId, specialtyId: randomUUID() },
		{ userId: unassignedUserId, specialtyId: foreignClinic.specialtyId },
	]) {
		const response = await registerProfessional(body);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Not Found" });
	}

});

it("rejects professional registration for a user with another role", async () => {
	expect((await registerProfessional({ userId: clinic.userId, specialtyId: clinic.specialtyId })).status).toBe(409);
});

it("registers a profile for an inactive professional user without changing the availability version", async () => {

	const body = { userId: inactiveUserId, specialtyId: clinic.specialtyId };
	const response = await registerProfessional(body);
	expect(response.status).toBe(201);
	const profile = await response.json();
	expect(profile).toEqual({ professionalId: expect.any(String) });

	const { rows } = await setup.query(
		`SELECT clinic_id AS "clinicId", user_id AS "userId", specialty_id AS "specialtyId"
		 FROM public.professionals WHERE professional_id = $1::uuid`,
		[profile.professionalId],
	);
	expect(rows).toEqual([{ clinicId: clinic.clinicId, ...body }]);
	expect((await readClinic(administratorToken)).version).toBe(clinic.version);

});

it("allows only one concurrent registration of a professional profile per user", async () => {

	const body = { userId: concurrentUserId, specialtyId: clinic.specialtyId };
	const responses = await Promise.all([registerProfessional(body), registerProfessional(body)]);
	expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
	const { rows } = await setup.query("SELECT professional_id FROM public.professionals WHERE user_id = $1::uuid", [concurrentUserId]);
	expect(rows).toHaveLength(1);

});

it("requires a clinic administrator token to edit a professional specialty", async () => {
	const body = { specialtyId: nextSpecialtyId };
	expect((await editProfessionalSpecialty(clinic.professionalId, body, "")).status).toBe(401);
	expect((await editProfessionalSpecialty(clinic.professionalId, body, receptionToken)).status).toBe(403);
});

it("hides unavailable profiles and specialties during professional specialty edits", async () => {

	for(const [professionalId, specialtyId] of [
		[randomUUID(), nextSpecialtyId],
		[foreignClinic.professionalId, nextSpecialtyId],
		[editableProfessionalId, randomUUID()],
		[editableProfessionalId, foreignClinic.specialtyId],
	]) {
		const response = await editProfessionalSpecialty(professionalId, { specialtyId });
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Not Found" });
	}

});

it("accepts unchanged professional specialties and blocks changes with active associations", async () => {

	const { professionalId, specialtyId } = clinic;
	const unchanged = await editProfessionalSpecialty(professionalId, { specialtyId: specialtyId.toUpperCase() });
	expect(unchanged.status).toBe(200);
	expect(await unchanged.json()).toEqual({ professionalId, specialtyId });
	expect((await editProfessionalSpecialty(professionalId, { specialtyId: nextSpecialtyId })).status).toBe(409);

});

it("changes a professional specialty while preserving inactive associations and the availability version", async () => {

	const { rows: [association] } = await setup.query<{ serviceId: string }>(
		`INSERT INTO public.professional_services (clinic_id, professional_id, service_id, is_active)
		 SELECT clinic_id, $1::uuid, service_id, false FROM public.services
		 WHERE clinic_id = $2::uuid AND specialty_id = $3::uuid LIMIT 1
		 RETURNING service_id AS "serviceId"`,
		[editableProfessionalId, clinic.clinicId, clinic.specialtyId],
	);
	const response = await editProfessionalSpecialty(editableProfessionalId, { specialtyId: nextSpecialtyId });
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ professionalId: editableProfessionalId, specialtyId: nextSpecialtyId });

	const { rows } = await setup.query(
		`SELECT professionals.clinic_id AS "clinicId", professionals.user_id AS "userId",
		        professionals.specialty_id AS "specialtyId", links.service_id AS "serviceId", links.is_active AS "isActive"
		 FROM public.professionals
		 JOIN public.professional_services AS links USING (clinic_id, professional_id)
		 WHERE professional_id = $1::uuid`,
		[editableProfessionalId],
	);
	expect(rows).toEqual([{
		clinicId: clinic.clinicId, userId: editableUserId, specialtyId: nextSpecialtyId,
		serviceId: association.serviceId, isActive: false,
	}]);
	expect((await readClinic(administratorToken)).version).toBe(clinic.version);

});
