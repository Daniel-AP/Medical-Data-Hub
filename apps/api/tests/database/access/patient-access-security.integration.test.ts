import { Client, escapeIdentifier } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { Patient, User } from "../../../src/generated/prisma/client.js";

type LocalUser = Pick<User, "userId" | "clinicId"> & { role: string };
type LocalPatient = Omit<Patient, "dateOfBirth"> & { dateOfBirth: string };

const setupConnectionString = process.env.DATABASE_SETUP_URL;
const apiConnectionString = process.env.DATABASE_URL;
if(!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const api = new Client({ connectionString: apiConnectionString });
const insertQuery = `INSERT INTO public.patients (clinic_id, identification, name, date_of_birth, email, phone)
    VALUES ($1::uuid, $2, $3, $4::date, $5, $6)`;
let users: LocalUser[];
let administrator: LocalUser;
let patients: LocalPatient[];
let target: LocalPatient;
let foreignPatient: LocalPatient;

beforeAll(async () => {

	await setup.connect();
	await api.connect();
	const userResult = await setup.query<LocalUser>(`
        SELECT user_id AS "userId", clinic_id AS "clinicId", role::text
        FROM public.users ORDER BY clinic_id NULLS LAST, user_id
    `);
	users = userResult.rows;
	administrator = users.find((user) => user.role === "clinic_administrator")!;
	const patientResult = await setup.query<LocalPatient>(`
        SELECT patient_id AS "patientId", clinic_id AS "clinicId", identification, name,
            date_of_birth::text AS "dateOfBirth", email, phone
        FROM public.patients ORDER BY patient_id
    `);
	patients = patientResult.rows;
	target = patients.find((patient) => patient.clinicId === administrator.clinicId)!;
	foreignPatient = patients.find((patient) => patient.clinicId !== administrator.clinicId)!;

});

beforeEach(async () => {

	await api.query("BEGIN");
	await api.query(
		`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
		[administrator.userId, administrator.clinicId],
	);
	await api.query("SET LOCAL ROLE clinic_administrator");

});

afterEach(async () => {
	await api.query("ROLLBACK");
});

afterAll(async () => {
	await api.end();
	await setup.end();
});

it("reads only same-clinic patient records as healthcare_professional", async () => {

	const profileName = "healthcare_professional";
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	const { rows } = await api.query(`
        SELECT patient_id AS "patientId", clinic_id AS "clinicId", identification, name,
            date_of_birth::text AS "dateOfBirth", email, phone
        FROM public.patients ORDER BY patient_id
    `);
	expect(rows).toEqual(patients.filter((patient) => patient.clinicId === actor.clinicId));

});

it("rejects foreign-clinic patient inserts through RLS as reception", async () => {

	const profileName = "reception";
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	await expect(
		api.query(insertQuery, [
			foreignPatient.clinicId,
			"DEMO-FOREIGN",
			"Synthetic patient",
			"1990-05-15",
			"patient@example.test",
			null,
		]),
	).rejects.toMatchObject({
		code: "42501",
		message: 'new row violates row-level security policy for table "patients"',
	});

});

it("denies patient access without context as reception", async () => {

	const profileName = "reception";
	const fresh = new Client({ connectionString: apiConnectionString });
	await fresh.connect();
	try {

		await fresh.query("BEGIN");
		await fresh.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		expect((await fresh.query("SELECT * FROM public.patients")).rows).toEqual([]);
		const updated = await fresh.query("UPDATE public.patients SET name = name WHERE patient_id = $1::uuid", [
			target.patientId,
		]);
		expect(updated.rowCount).toBe(0);
		await expect(
			fresh.query(insertQuery, [
				administrator.clinicId,
				"DEMO-PATIENT-NEW",
				"Synthetic patient",
				"1990-05-15",
				"patient@example.test",
				null,
			]),
		).rejects.toMatchObject({
			code: "42501",
			message: 'new row violates row-level security policy for table "patients"',
		});

	} finally {
		await fresh.query("ROLLBACK");
		await fresh.end();
	}

});
