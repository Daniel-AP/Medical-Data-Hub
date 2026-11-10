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
const fixtureUserIds = [inactiveUserId, concurrentUserId, unassignedUserId];

const registerProfessional = (body: object, token = administratorToken) => {

	return fetch(professionalUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(body),
	});

};

const readClinic = async (token: string) => {

	const { rows: [clinic] } = await setup.query<{ clinicId: string; userId: string; specialtyId: string; version: string }>(
		`SELECT users.clinic_id AS "clinicId", users.user_id AS "userId",
		        specialties.specialty_id AS "specialtyId", versions.version
		 FROM public.users
		 JOIN public.specialties USING (clinic_id)
		 JOIN public.clinic_availability_versions AS versions USING (clinic_id)
		 WHERE users.identity_id = $1 ORDER BY specialties.specialty_id LIMIT 1`,
		[decodeJwt(token).sub],
	);

	return clinic;

};

let clinic: Awaited<ReturnType<typeof readClinic>>;
let foreignClinic: Awaited<ReturnType<typeof readClinic>>;

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

});

afterAll(async () => {
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
