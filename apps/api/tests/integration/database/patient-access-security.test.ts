import { Client, escapeIdentifier } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { Patient, User } from "../../../src/generated/prisma/client.js";

type LocalUser = Pick<User, "userId" | "clinicId"> & { role: string };
type LocalPatient = Omit<Patient, "dateOfBirth"> & { dateOfBirth: string };

const setupConnectionString = process.env.DATABASE_SETUP_URL;
const apiConnectionString = process.env.DATABASE_URL;
if (!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const api = new Client({ connectionString: apiConnectionString });
const profileNames = ["clinic_administrator", "reception", "healthcare_professional"];
const writerProfiles = ["clinic_administrator", "reception"];
const insertQuery = `INSERT INTO public.patients (clinic_id, identification, name, date_of_birth, email, phone)
    VALUES ($1::uuid, $2, $3, $4::date, $5, $6)`;
let users: LocalUser[];
let administrator: LocalUser;
let patients: LocalPatient[];
let target: LocalPatient;
let otherPatient: LocalPatient;
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
	[target, otherPatient] = patients.filter((patient) => patient.clinicId === administrator.clinicId);
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

it("allows same-clinic patient insertion and editable-field updates as reception", async () => {
	const profileName = "reception";
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	const inserted = await api.query(
		insertQuery + " RETURNING patient_id, clinic_id, identification, name, date_of_birth::text, email, phone",
		[actor.clinicId, "DEMO-PATIENT-NEW", "Synthetic patient", "1990-05-15", "patient@example.test", null],
	);
	const patientId = inserted.rows[0].patient_id;
	expect(inserted.rows).toEqual([
		{
			patient_id: expect.any(String),
			clinic_id: actor.clinicId,
			identification: "DEMO-PATIENT-NEW",
			name: "Synthetic patient",
			date_of_birth: "1990-05-15",
			email: "patient@example.test",
			phone: null,
		},
	]);
	const updated = await api.query(
		`UPDATE public.patients SET identification = $2, name = $3, date_of_birth = $4::date, email = $5, phone = $6
        WHERE patient_id = $1::uuid RETURNING patient_id, clinic_id, identification, name, date_of_birth::text, email, phone`,
		[patientId, "DEMO-PATIENT-UPDATED", "Updated synthetic patient", "1992-03-20", null, "00123456"],
	);
	expect(updated.rows).toEqual([
		{
			patient_id: patientId,
			clinic_id: actor.clinicId,
			identification: "DEMO-PATIENT-UPDATED",
			name: "Updated synthetic patient",
			date_of_birth: "1992-03-20",
			email: null,
			phone: "00123456",
		},
	]);
});

it("rejects duplicate local patient identification during INSERT as reception", async () => {
	const { profileName, operation } = { profileName: "reception", operation: "INSERT" };
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	const query =
		operation === "INSERT"
			? insertQuery
			: "UPDATE public.patients SET identification = $2 WHERE patient_id = $1::uuid";
	const values =
		operation === "INSERT"
			? [actor.clinicId, target.identification, "Synthetic patient", "1990-05-15", "patient@example.test", null]
			: [otherPatient.patientId, target.identification];
	await expect(api.query(query, values)).rejects.toMatchObject({
		code: "23505",
		constraint: "patients_identification_key",
	});
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

it("filters foreign patient updates as reception", async () => {
	const profileName = "reception";
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	const result = await api.query("UPDATE public.patients SET name = name WHERE patient_id = $1::uuid", [
		foreignPatient.patientId,
	]);
	expect(result.rowCount).toBe(0);
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

it("grants only the designed patient table and column privileges", async () => {
	const roles = [
		"medical_data_hub_api",
		"platform_administrator",
		...profileNames,
		"medical_data_hub_identity_owner",
		"medical_data_hub_metadata_owner",
		"medical_data_hub_locking_owner",
	];
	const tableGrants = await setup.query(
		`SELECT grantee, privilege_type, is_grantable FROM information_schema.table_privileges
        WHERE table_schema = 'public' AND table_name = 'patients' AND grantee = ANY($1::text[])
        ORDER BY grantee, privilege_type`,
		[roles],
	);
	expect(tableGrants.rows).toEqual([
		{ grantee: "clinic_administrator", privilege_type: "INSERT", is_grantable: "NO" },
		{ grantee: "clinic_administrator", privilege_type: "SELECT", is_grantable: "NO" },
		{ grantee: "healthcare_professional", privilege_type: "SELECT", is_grantable: "NO" },
		{ grantee: "reception", privilege_type: "INSERT", is_grantable: "NO" },
		{ grantee: "reception", privilege_type: "SELECT", is_grantable: "NO" },
	]);
	const updateGrants = await setup.query(
		`SELECT grantee, column_name, is_grantable FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = 'patients' AND grantee = ANY($1::text[]) AND privilege_type = 'UPDATE'
        ORDER BY grantee, column_name`,
		[roles],
	);
	expect(updateGrants.rows).toEqual(
		writerProfiles.flatMap((grantee) =>
			["date_of_birth", "email", "identification", "name", "phone"].map((columnName) => ({
				grantee,
				column_name: columnName,
				is_grantable: "NO",
			})),
		),
	);
});
