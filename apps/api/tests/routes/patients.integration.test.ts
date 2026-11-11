import { randomUUID } from "node:crypto";
import { decodeJwt } from "jose";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Patient } from "../../src/generated/prisma/client.js";

const apiUrl = process.env.PATIENT_TEST_API_URL;
const setupUrl = process.env.PATIENT_TEST_DATABASE_SETUP_URL;
const administratorToken = process.env.PATIENT_TEST_ADMIN_TOKEN;
const foreignAdministratorToken = process.env.PATIENT_TEST_FOREIGN_ADMIN_TOKEN;
const receptionToken = process.env.PATIENT_TEST_RECEPTION_TOKEN;
const professionalToken = process.env.PATIENT_TEST_PROFESSIONAL_TOKEN;
const platformToken = process.env.PATIENT_TEST_PLATFORM_TOKEN;
const hasTokens = administratorToken && foreignAdministratorToken && receptionToken && professionalToken && platformToken;
if(!apiUrl || !setupUrl || !hasTokens) {
	throw new Error("Configure the patient test API, disposable database setup URL, and Keycloak tokens");
}

const setup = new Pool({ connectionString: setupUrl });
const registration = {
	identification: ` Ab-${randomUUID()} `,
	name: "  Synthetic patient  ",
	dateOfBirth: "1990-05-15",
	email: "patient@example.test",
	phone: "+506 (0012)-3456",
};
let actor: { userId: string; clinicId: string };

const registerPatient = (body: unknown, token = receptionToken) => {

	return fetch(new URL("/patients", apiUrl), {
		method: "POST",
		headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(body),
	});

};

const editPatient = (patientId: string, body: object, token = receptionToken) => {

	return fetch(new URL(`/patients/${patientId}`, apiUrl), {
		method: "PATCH",
		headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(body),
	});

};

const createPatientFixture = async () => {

	const { rows: [patient] } = await setup.query<Pick<Patient, "patientId">>(
		`INSERT INTO public.patients (clinic_id, identification, name, date_of_birth, email, phone)
		 VALUES ($1, $2, $3, $4::date, $5, $6) RETURNING patient_id AS "patientId"`,
		[actor.clinicId, randomUUID(), registration.name, registration.dateOfBirth, registration.email, registration.phone],
	);

	return patient.patientId;

};

beforeAll(async () => {

	const { rows } = await setup.query<typeof actor>(
		`SELECT user_id AS "userId", clinic_id AS "clinicId" FROM public.users WHERE identity_id = $1`,
		[decodeJwt(receptionToken).sub],
	);
	[actor] = rows;

});

afterAll(async () => {
	await setup.end();
});

it("registers a patient with a contact write event in the reception user's clinic", async () => {

	const versionQuery = "SELECT version FROM public.clinic_availability_versions WHERE clinic_id = $1";
	const version = (await setup.query(versionQuery, [actor.clinicId])).rows[0].version;
	const response = await registerPatient(registration);
	expect(response.status).toBe(201);
	const patient = await response.json();
	expect(patient).toEqual({ patientId: expect.any(String), created: true });

	const { rows } = await setup.query(
		`SELECT clinic_id AS "clinicId", identification, name, date_of_birth::text AS "dateOfBirth", email, phone,
		        xmin::text AS "transactionId" FROM public.patients WHERE patient_id = $1::uuid`,
		[patient.patientId],
	);
	expect(rows).toEqual([{ ...registration, clinicId: actor.clinicId, transactionId: expect.any(String) }]);
	const events = await setup.query(
		`SELECT clinic_id AS "clinicId", user_id AS "userId", patient_id AS "patientId", resource,
		        appointment_id AS "appointmentId", action, occurred_at AS "occurredAt", xmin::text AS "transactionId"
		 FROM public.audit_records WHERE patient_id = $1::uuid`,
		[patient.patientId],
	);
	expect(events.rows).toEqual([{
		...actor,
		patientId: patient.patientId,
		resource: "patient_contact",
		appointmentId: null,
		action: "write",
		occurredAt: expect.any(Date),
		transactionId: rows[0].transactionId,
	}]);
	expect((await setup.query(versionQuery, [actor.clinicId])).rows[0].version).toBe(version);

});

it("requires a valid token and a patient writer role to register a patient", async () => {

	for(const token of ["", "invalid-token"]) {
		expect((await registerPatient(registration, token)).status).toBe(401);
	}
	for(const token of [professionalToken, platformToken]) {
		expect((await registerPatient(registration, token)).status).toBe(403);
	}

});

it("rejects patient registration when the local actor is inactive or no longer has the token role", async () => {

	try {

		await setup.query("UPDATE public.users SET is_active = false WHERE user_id = $1", [actor.userId]);
		expect((await registerPatient(registration)).status).toBe(403);
		await setup.query("UPDATE public.users SET is_active = true, role = 'healthcare_professional' WHERE user_id = $1", [actor.userId]);
		expect((await registerPatient(registration)).status).toBe(403);

	} finally {
		await setup.query("UPDATE public.users SET is_active = true, role = 'reception' WHERE user_id = $1", [actor.userId]);
	}

});

it("rejects invalid patient registration fields and clinic overrides", async () => {

	const invalidBodies = [
		{},
		{ ...registration, identification: " " },
		{ ...registration, identification: "x".repeat(51) },
		{ ...registration, identification: "invalid\0id" },
		{ ...registration, name: null },
		{ ...registration, name: "x".repeat(201) },
		{ ...registration, dateOfBirth: "2025-02-29" },
		{ ...registration, email: "invalid" },
		{ ...registration, email: "patient@example.test\n" },
		{ ...registration, email: "x".repeat(310)+"@example.test" },
		{ ...registration, phone: 123456 },
		{ ...registration, phone: "call-me" },
		{ ...registration, phone: "+ ()-" },
		{ ...registration, phone: "1".repeat(33) },
		{ ...registration, email: "" },
		{ ...registration, email: null, phone: null },
		{ ...registration, email: undefined, phone: undefined },
		{ ...registration, clinicId: randomUUID() },
	];
	for(const body of invalidBodies) {
		expect((await registerPatient(body)).status, JSON.stringify(body)).toBe(400);
	}

});

it("registers patients with one contact method and accepts the clinic administrator", async () => {

	const contacts = [{ email: undefined, phone: "00123456" }, { email: "single@example.test", phone: null }];
	for(const contact of contacts) {

		const response = await registerPatient({ ...registration, identification: randomUUID(), ...contact }, administratorToken);
		expect(response.status).toBe(201);
		const { patientId } = await response.json();
		const { rows } = await setup.query("SELECT email, phone FROM public.patients WHERE patient_id = $1", [patientId]);
		expect(rows).toEqual([{ email: contact.email ?? null, phone: contact.phone }]);

	}

});

it("validates the birth date against the current date in the authorized clinic's time zone", async () => {

	const { rows: [clinic] } = await setup.query("SELECT time_zone FROM public.clinics WHERE clinic_id = $1", [actor.clinicId]);
	try {

		for(const timeZone of ["Etc/GMT+12", "Pacific/Kiritimati"]) {

			await setup.query("UPDATE public.clinics SET time_zone = $2 WHERE clinic_id = $1", [actor.clinicId, timeZone]);
			const { rows: [dates] } = await setup.query(
				`SELECT (clock_timestamp() AT TIME ZONE $1)::date::text AS today,
				        ((clock_timestamp() AT TIME ZONE $1)::date+1)::text AS tomorrow`,
				[timeZone],
			);
			expect((await registerPatient({ ...registration, identification: randomUUID(), dateOfBirth: dates.today })).status).toBe(201);
			const identification = randomUUID();
			expect((await registerPatient({ ...registration, identification, dateOfBirth: dates.tomorrow })).status).toBe(400);
			expect((await setup.query("SELECT 1 FROM public.patients WHERE identification = $1", [identification])).rows).toEqual([]);

		}

	} finally {
		await setup.query("UPDATE public.clinics SET time_zone = $2 WHERE clinic_id = $1", [actor.clinicId, clinic.time_zone]);
	}

});

it("keeps one patient and audit event when concurrent registrations use the same identification", async () => {

	const identification = randomUUID();
	const responses = await Promise.all([
		registerPatient({ ...registration, identification }),
		registerPatient({ ...registration, identification, email: "other@example.test" }, administratorToken),
	]);
	expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
	const winner = responses.findIndex(({ status }) => status === 201);
	const patient = await responses[winner].json();
	expect(await responses[1-winner].json()).toEqual({ error: "Conflict" });
	const { rows } = await setup.query(
		`SELECT patient.patient_id AS "patientId", patient.email, event.action FROM public.patients AS patient
		 JOIN public.audit_records AS event USING (clinic_id, patient_id)
		 WHERE patient.clinic_id = $1 AND patient.identification = $2`,
		[actor.clinicId, identification],
	);
	expect(rows).toEqual([{
		patientId: patient.patientId,
		email: winner === 0 ? registration.email : "other@example.test",
		action: "write",
	}]);

});

it("allows the same patient identification in different authorized clinics", async () => {

	const identification = randomUUID();
	expect((await registerPatient({ ...registration, identification })).status).toBe(201);
	expect((await registerPatient({ ...registration, identification }, foreignAdministratorToken)).status).toBe(201);
	const { rows } = await setup.query("SELECT clinic_id FROM public.patients WHERE identification = $1", [identification]);
	expect(new Set(rows.map(({ clinic_id }) => clinic_id)).size).toBe(2);

});

it("rolls back patient registration when the contact write event fails", async () => {

	const identification = randomUUID();
	await setup.query(`
		CREATE FUNCTION public.reject_test_patient_audit() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			IF EXISTS (SELECT 1 FROM public.patients WHERE patient_id = NEW.patient_id AND identification = TG_ARGV[0]) THEN
				RAISE EXCEPTION 'Synthetic patient audit failure';
			END IF;
			RETURN NEW;
		END; $$;
		CREATE TRIGGER reject_test_patient_audit BEFORE INSERT ON public.audit_records
		FOR EACH ROW WHEN (NEW.resource = 'patient_contact')
		EXECUTE FUNCTION public.reject_test_patient_audit('${identification}');
	`);
	try {

		const response = await registerPatient({ ...registration, identification });
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "Internal Server Error" });
		expect((await setup.query("SELECT 1 FROM public.patients WHERE identification = $1", [identification])).rows).toEqual([]);

	} finally {

		await setup.query(`
			DROP TRIGGER reject_test_patient_audit ON public.audit_records;
			DROP FUNCTION public.reject_test_patient_audit();
		`);

	}

});

it("updates supplied patient fields and commits attributed contact events without changing availability", async () => {

	const patientId = await createPatientFixture();
	const versionQuery = "SELECT version FROM public.clinic_availability_versions WHERE clinic_id = $1";
	const version = (await setup.query(versionQuery, [actor.clinicId])).rows[0].version;
	const changes = { identification: ` New-${randomUUID()} `, name: " Updated synthetic patient ", dateOfBirth: "2000-02-29", email: null, phone: "00123456" };
	const response = await editPatient(patientId, changes);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ patientId, updated: true });
	const { rows: [patient] } = await setup.query(
		`SELECT patient_id AS "patientId", clinic_id AS "clinicId", identification, name,
		        date_of_birth::text AS "dateOfBirth", email, phone, xmin::text AS "transactionId"
		 FROM public.patients WHERE patient_id = $1`,
		[patientId],
	);
	expect(patient).toEqual({ ...changes, patientId, clinicId: actor.clinicId, transactionId: expect.any(String) });
	const { rows: events } = await setup.query(
		`SELECT clinic_id AS "clinicId", user_id AS "userId", patient_id AS "patientId", resource,
		        appointment_id AS "appointmentId", action, xmin::text AS "transactionId"
		 FROM public.audit_records WHERE patient_id = $1 ORDER BY action`,
		[patientId],
	);
	expect(events).toEqual(["read", "write"].map((action) => ({
		...actor, patientId, resource: "patient_contact", appointmentId: null, action, transactionId: patient.transactionId,
	})));
	expect((await setup.query(versionQuery, [actor.clinicId])).rows[0].version).toBe(version);

});

it("authorizes and validates partial patient edits", async () => {

	const patientId = await createPatientFixture();
	const changes = { name: "Updated synthetic patient" };
	expect((await editPatient(patientId, changes, "")).status).toBe(401);
	for(const token of [professionalToken, platformToken]) {
		expect((await editPatient(patientId, changes, token)).status).toBe(403);
	}
	expect((await editPatient("invalid", changes)).status).toBe(400);
	const invalidBodies = [
		{}, { identification: null }, { identification: " " }, { identification: "x".repeat(51) },
		{ name: null }, { name: " " }, { name: "x".repeat(201) },
		{ dateOfBirth: "2025-02-29" }, { email: "invalid" }, { phone: 123456 }, { phone: "" },
		{ clinicId: randomUUID() }, { patientId: randomUUID() },
	];
	for(const body of invalidBodies) {
		expect((await editPatient(patientId, body)).status, JSON.stringify(body)).toBe(400);
	}
	expect((await setup.query("SELECT 1 FROM public.audit_records WHERE patient_id = $1", [patientId])).rows).toEqual([]);

});

it("hides missing and foreign patients during edits without recording contact reads", async () => {

	const patientId = await createPatientFixture();
	const missing = await editPatient(randomUUID(), { name: "Missing" });
	const foreign = await editPatient(patientId, { name: "Foreign" }, foreignAdministratorToken);
	expect(missing.status).toBe(404);
	expect(foreign.status).toBe(404);
	expect(await missing.json()).toEqual({ error: "Not Found" });
	expect(await foreign.json()).toEqual({ error: "Not Found" });
	expect((await setup.query("SELECT 1 FROM public.audit_records WHERE patient_id = $1", [patientId])).rows).toEqual([]);

});

it.each([
	{ label: "a name-only patient edit", changes: { name: "Updated synthetic patient" }, actions: ["read"] },
	{ label: "an unchanged patient contact assignment", changes: { email: registration.email }, actions: ["read", "write"] },
])("commits the required contact events for $label", async ({ changes, actions }) => {

	const patientId = await createPatientFixture();
	const response = await editPatient(patientId, changes, administratorToken);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ patientId, updated: true });
	const { rows } = await setup.query("SELECT email, phone FROM public.patients WHERE patient_id = $1", [patientId]);
	expect(rows).toEqual([{ email: registration.email, phone: registration.phone }]);
	const events = await setup.query("SELECT action FROM public.audit_records WHERE patient_id = $1 ORDER BY action", [patientId]);
	expect(events.rows).toEqual(actions.map((action) => ({ action })));

});

it("rejects invalid final patient records and duplicate identification without retaining contact reads", async () => {

	const patientId = await createPatientFixture();
	const otherPatientId = await createPatientFixture();
	const { rows: [other] } = await setup.query("SELECT identification FROM public.patients WHERE patient_id = $1", [otherPatientId]);
	const patientQuery = "SELECT identification, name, date_of_birth::text, email, phone FROM public.patients WHERE patient_id = $1";
	const original = (await setup.query(patientQuery, [patientId])).rows;
	const cases = [
		{ changes: { email: null, phone: null }, status: 400 },
		{ changes: { dateOfBirth: "9999-12-31" }, status: 400 },
		{ changes: { identification: other.identification }, status: 409 },
	];
	for(const { changes, status } of cases) {

		expect((await editPatient(patientId, changes)).status).toBe(status);
		expect((await setup.query(patientQuery, [patientId])).rows).toEqual(original);
		expect((await setup.query("SELECT 1 FROM public.audit_records WHERE patient_id = $1", [patientId])).rows).toEqual([]);

	}

});

it("preserves valid concurrent partial patient edits to different fields", async () => {

	const patientId = await createPatientFixture();
	const responses = await Promise.all([
		editPatient(patientId, { name: "Concurrent synthetic patient" }),
		editPatient(patientId, { phone: "00987654" }),
	]);
	expect(responses.map(({ status }) => status)).toEqual([200, 200]);
	const { rows } = await setup.query("SELECT name, email, phone FROM public.patients WHERE patient_id = $1", [patientId]);
	expect(rows).toEqual([{ name: "Concurrent synthetic patient", email: registration.email, phone: "00987654" }]);

});

it("rejects the concurrent edit that would remove the final patient contact and rolls back its read event", async () => {

	const patientId = await createPatientFixture();
	const responses = await Promise.all([
		editPatient(patientId, { email: null }),
		editPatient(patientId, { phone: null }),
	]);
	expect(responses.map(({ status }) => status).sort()).toEqual([200, 400]);
	const winner = responses.findIndex(({ status }) => status === 200);
	const { rows } = await setup.query("SELECT email, phone FROM public.patients WHERE patient_id = $1", [patientId]);
	expect(rows).toEqual([{
		email: winner === 0 ? null : registration.email,
		phone: winner === 1 ? null : registration.phone,
	}]);
	const events = await setup.query("SELECT action FROM public.audit_records WHERE patient_id = $1 ORDER BY action", [patientId]);
	expect(events.rows).toEqual([{ action: "read" }, { action: "write" }]);

});

it.each(["read", "write"])("rolls back a patient edit when the contact %s event fails", async (action) => {

	const patientId = await createPatientFixture();
	await setup.query(`
		CREATE FUNCTION public.reject_test_patient_edit_audit() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'Synthetic patient edit audit failure'; END; $$;
		CREATE TRIGGER reject_test_patient_edit_audit BEFORE INSERT ON public.audit_records
		FOR EACH ROW WHEN (NEW.patient_id = '${patientId}'::uuid AND NEW.action = '${action}')
		EXECUTE FUNCTION public.reject_test_patient_edit_audit();
	`);
	try {

		const response = await editPatient(patientId, { email: "changed@example.test" });
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "Internal Server Error" });
		const { rows } = await setup.query("SELECT email, phone FROM public.patients WHERE patient_id = $1", [patientId]);
		expect(rows).toEqual([{ email: registration.email, phone: registration.phone }]);
		expect((await setup.query("SELECT 1 FROM public.audit_records WHERE patient_id = $1", [patientId])).rows).toEqual([]);

	} finally {

		await setup.query(`
			DROP TRIGGER reject_test_patient_edit_audit ON public.audit_records;
			DROP FUNCTION public.reject_test_patient_edit_audit();
		`);

	}

});
