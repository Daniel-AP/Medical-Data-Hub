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
const invalidContexts = [
	{ field: "app.user_id", value: "", label: "an empty actor", malformed: false },
	{ field: "app.clinic_id", value: "", label: "an empty clinic", malformed: false },
	{ field: "app.user_id", value: null, label: "a reset actor", malformed: false },
	{ field: "app.clinic_id", value: null, label: "a reset clinic", malformed: false },
	{ field: "app.user_id", value: "not-a-uuid", label: "a malformed actor", malformed: true },
	{ field: "app.clinic_id", value: "not-a-uuid", label: "a malformed clinic", malformed: true },
];
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

it.each(profileNames)("reads only same-clinic patient records as %s", async (profileName) => {
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

it.each(profileNames)("filters another clinic's patient identifier as %s", async (profileName) => {
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	expect(
		(await api.query("SELECT * FROM public.patients WHERE patient_id = $1::uuid", [foreignPatient.patientId])).rows,
	).toEqual([]);
});

it.each(writerProfiles)(
	"allows same-clinic patient insertion and editable-field updates as %s",
	async (profileName) => {
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
	},
);

it.each(writerProfiles)("allows direct patient row locking as %s", async (profileName) => {
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	const { rows } = await api.query(
		"SELECT patient_id FROM public.patients WHERE patient_id = $1::uuid FOR NO KEY UPDATE",
		[target.patientId],
	);
	expect(rows).toEqual([{ patient_id: target.patientId }]);
});

it.each(writerProfiles)("allows the same patient identification in different clinics as %s", async (profileName) => {
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	const foreignActor = users.find((user) => user.role === profileName && user.clinicId === foreignPatient.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	const first = await api.query(insertQuery, [
		actor.clinicId,
		"DEMO-SHARED-ID",
		"Synthetic patient",
		"1990-05-15",
		null,
		"00123456",
	]);
	await api.query(
		`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
		[foreignActor.userId, foreignActor.clinicId],
	);
	const second = await api.query(insertQuery, [
		foreignActor.clinicId,
		"DEMO-SHARED-ID",
		"Synthetic patient",
		"1990-05-15",
		"patient@example.test",
		null,
	]);
	expect(first.rowCount).toBe(1);
	expect(second.rowCount).toBe(1);
});

const writerOperations = writerProfiles.flatMap((profileName) =>
	["INSERT", "UPDATE"].map((operation) => ({ profileName, operation })),
);

it.each(writerOperations)(
	"rejects duplicate local patient identification during $operation as $profileName",
	async ({ profileName, operation }) => {
		const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
		await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		const query =
			operation === "INSERT"
				? insertQuery
				: "UPDATE public.patients SET identification = $2 WHERE patient_id = $1::uuid";
		const values =
			operation === "INSERT"
				? [
						actor.clinicId,
						target.identification,
						"Synthetic patient",
						"1990-05-15",
						"patient@example.test",
						null,
					]
				: [otherPatient.patientId, target.identification];
		await expect(api.query(query, values)).rejects.toMatchObject({
			code: "23505",
			constraint: "patients_identification_key",
		});
	},
);

it.each(
	writerOperations.flatMap((access) => ["identification", "name"].map((columnName) => ({ ...access, columnName }))),
)(
	"rejects empty patient $columnName during $operation as $profileName",
	async ({ profileName, operation, columnName }) => {
		const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
		await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		const query =
			operation === "INSERT"
				? insertQuery
				: `UPDATE public.patients SET ${escapeIdentifier(columnName)} = '' WHERE patient_id = $1::uuid`;
		const values =
			operation === "INSERT"
				? [
						actor.clinicId,
						columnName === "identification" ? "" : "DEMO-PATIENT-CHECK",
						columnName === "name" ? "" : "Synthetic patient",
						"1990-05-15",
						"patient@example.test",
						null,
					]
				: [target.patientId];
		await expect(api.query(query, values)).rejects.toMatchObject({
			code: "23514",
			constraint: `patients_${columnName}_check`,
		});
	},
);

const invalidContacts = [
	{ label: "missing contact", email: null, phone: null },
	{ label: "empty email", email: "", phone: "00123456" },
	{ label: "empty phone", email: "patient@example.test", phone: "" },
];

it.each(writerOperations.flatMap((access) => invalidContacts.map((contact) => ({ ...access, ...contact }))))(
	"rejects $label during patient $operation as $profileName",
	async ({ profileName, operation, email, phone }) => {
		const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
		await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		const query =
			operation === "INSERT"
				? insertQuery
				: "UPDATE public.patients SET email = $2, phone = $3 WHERE patient_id = $1::uuid";
		const values =
			operation === "INSERT"
				? [actor.clinicId, "DEMO-PATIENT-CHECK", "Synthetic patient", "1990-05-15", email, phone]
				: [target.patientId, email, phone];
		await expect(api.query(query, values)).rejects.toMatchObject({
			code: "23514",
			constraint: "patients_contact_check",
		});
	},
);

it.each(writerProfiles)("rejects foreign-clinic patient inserts through RLS as %s", async (profileName) => {
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

it.each(writerProfiles)("filters foreign patient updates as %s", async (profileName) => {
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	const result = await api.query("UPDATE public.patients SET name = name WHERE patient_id = $1::uuid", [
		foreignPatient.patientId,
	]);
	expect(result.rowCount).toBe(0);
});

it.each(
	writerProfiles.flatMap((profileName) =>
		["patient_id", "clinic_id"].map((columnName) => ({ profileName, columnName })),
	),
)("denies patients.$columnName updates to $profileName", async ({ profileName, columnName }) => {
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	const column = escapeIdentifier(columnName);
	await expect(
		api.query(`UPDATE public.patients SET ${column} = ${column} WHERE patient_id = $1::uuid`, [target.patientId]),
	).rejects.toMatchObject({ code: "42501" });
});

it.each(["INSERT", "UPDATE"])("denies patient %s to healthcare professionals", async (operation) => {
	const actor = users.find(
		(user) => user.role === "healthcare_professional" && user.clinicId === administrator.clinicId,
	)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query("SET LOCAL ROLE healthcare_professional");
	const query =
		operation === "INSERT" ? insertQuery : "UPDATE public.patients SET name = name WHERE patient_id = $1::uuid";
	const values =
		operation === "INSERT"
			? [actor.clinicId, "DEMO-PATIENT-NEW", "Synthetic patient", "1990-05-15", "patient@example.test", null]
			: [target.patientId];
	await expect(api.query(query, values)).rejects.toMatchObject({ code: "42501" });
});

it.each(profileNames.flatMap((profileName) => ["DELETE", "TRUNCATE"].map((operation) => ({ profileName, operation }))))(
	"denies patient $operation to $profileName",
	async ({ profileName, operation }) => {
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		const query =
			operation === "DELETE"
				? "DELETE FROM public.patients WHERE patient_id = $1::uuid"
				: "TRUNCATE public.patients";
		await expect(api.query(query, operation === "DELETE" ? [target.patientId] : [])).rejects.toMatchObject({
			code: "42501",
		});
	},
);

it.each([
	"medical_data_hub_api",
	"platform_administrator",
	"medical_data_hub_identity_owner",
	"medical_data_hub_metadata_owner",
	"medical_data_hub_locking_owner",
])("denies ordinary patient reads to %s despite supplied context", async (profileName) => {
	await setup.query("BEGIN");
	try {
		await setup.query(
			`SELECT pg_catalog.set_config('app.user_id', $1, true),
                    pg_catalog.set_config('app.clinic_id', $2, true)`,
			[administrator.userId, administrator.clinicId],
		);
		await setup.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		await expect(setup.query("SELECT * FROM public.patients")).rejects.toMatchObject({ code: "42501" });
	} finally {
		await setup.query("ROLLBACK");
	}
});

it.each(profileNames.flatMap((profileName) => invalidContexts.map((context) => ({ profileName, ...context }))))(
	"restricts patient reads with $label as $profileName",
	async ({ profileName, field, value, malformed }) => {
		const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
		await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
		await api.query("SELECT pg_catalog.set_config($1, $2, true)", [field, value]);
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		const result = api.query("SELECT * FROM public.patients");
		if (malformed) {
			await expect(result).rejects.toMatchObject({ code: "22P02" });
		} else {
			expect((await result).rows).toEqual([]);
		}
	},
);

it.each(writerProfiles.flatMap((profileName) => invalidContexts.map((context) => ({ profileName, ...context }))))(
	"rejects patient inserts with $label as $profileName",
	async ({ profileName, field, value, malformed }) => {
		const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
		await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
		await api.query("SELECT pg_catalog.set_config($1, $2, true)", [field, value]);
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		const expected = malformed
			? { code: "22P02" }
			: { code: "42501", message: 'new row violates row-level security policy for table "patients"' };
		await expect(
			api.query(insertQuery, [
				actor.clinicId,
				"DEMO-PATIENT-NEW",
				"Synthetic patient",
				"1990-05-15",
				"patient@example.test",
				null,
			]),
		).rejects.toMatchObject(expected);
	},
);

it.each(writerProfiles.flatMap((profileName) => invalidContexts.map((context) => ({ profileName, ...context }))))(
	"restricts patient updates with $label as $profileName",
	async ({ profileName, field, value, malformed }) => {
		const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
		await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
		await api.query("SELECT pg_catalog.set_config($1, $2, true)", [field, value]);
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		const result = api.query("UPDATE public.patients SET name = name WHERE patient_id = $1::uuid", [
			target.patientId,
		]);
		if (malformed) {
			await expect(result).rejects.toMatchObject({ code: "22P02" });
		} else {
			expect((await result).rowCount).toBe(0);
		}
	},
);

it.each(writerProfiles)("denies patient access without context as %s", async (profileName) => {
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
