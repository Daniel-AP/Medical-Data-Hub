import { Client, escapeIdentifier } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { Appointment, AuditRecord, User } from "../../../src/generated/prisma/client.js";

type LocalUser = Pick<User, "userId" | "clinicId"> & { role: string };
type AuditReference = Pick<AuditRecord, "clinicId" | "userId" | "patientId" | "appointmentId">;

const setupConnectionString = process.env.DATABASE_SETUP_URL;
const apiConnectionString = process.env.DATABASE_URL;
if (!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const api = new Client({ connectionString: apiConnectionString });
const clinicProfiles = ["clinic_administrator", "reception", "healthcare_professional"];
const excludedProfiles = ["medical_data_hub_api", "platform_administrator"];
const insertColumns = ["clinic_id", "user_id", "patient_id", "resource", "appointment_id", "action"];
const insertQuery = `INSERT INTO public.audit_records (${insertColumns.join(", ")})
    VALUES ($1::uuid, $2::uuid, $3::uuid, $4::public.audit_resource, $5::uuid, $6::public.audit_action)`;
const readQuery = 'SELECT *, clinic_id AS "clinicId" FROM public.audit_records ORDER BY audit_record_id';
const rlsViolation = { code: "42501", message: 'new row violates row-level security policy for table "audit_records"' };
const permissionDenied = { code: "42501", message: "permission denied for table audit_records" };
const invalidContexts = [
	{ field: "app.user_id", value: "", label: "an empty actor", malformed: false },
	{ field: "app.clinic_id", value: "", label: "an empty clinic", malformed: false },
	{ field: "app.user_id", value: null, label: "a reset actor", malformed: false },
	{ field: "app.clinic_id", value: null, label: "a reset clinic", malformed: false },
	{ field: "app.user_id", value: "not-a-uuid", label: "a malformed actor", malformed: true },
	{ field: "app.clinic_id", value: "not-a-uuid", label: "a malformed clinic", malformed: true },
];

let localContact: AuditReference;
let foreignContact: AuditReference;
let ownNote: AuditReference;
let otherNote: AuditReference;
let foreignNote: AuditReference;
let appointmentWithoutNote: Pick<Appointment, "appointmentId" | "patientId">;
let users: LocalUser[];

beforeAll(async () => {
	await setup.connect();
	await api.connect();

	const events = await setup.query<AuditReference & { resource: string }>(`
        SELECT clinic_id AS "clinicId", user_id AS "userId", patient_id AS "patientId",
            appointment_id AS "appointmentId", resource::text
        FROM public.audit_records ORDER BY audit_record_id
    `);
	const contacts = events.rows.filter((event) => event.resource === "patient_contact");
	const notes = events.rows.filter((event) => event.resource === "clinical_note");
	localContact = contacts[0];
	foreignContact = contacts.find((event) => event.clinicId !== localContact.clinicId)!;
	ownNote = notes.find((event) => event.clinicId === localContact.clinicId)!;
	otherNote = notes.find((event) => event.clinicId === localContact.clinicId && event.userId !== ownNote.userId)!;
	foreignNote = notes.find((event) => event.clinicId !== localContact.clinicId)!;
	users = (
		await setup.query<LocalUser>(
			'SELECT clinic_id AS "clinicId", user_id AS "userId", role::text FROM public.users',
		)
	).rows;

	const appointments = await setup.query<Pick<Appointment, "appointmentId" | "patientId">>(
		`SELECT appointment.appointment_id AS "appointmentId", appointment.patient_id AS "patientId"
        FROM public.appointments AS appointment
        JOIN public.professionals AS professional USING (professional_id, clinic_id)
        LEFT JOIN public.clinical_notes AS note USING (appointment_id, clinic_id)
        WHERE professional.user_id = $1::uuid AND note.appointment_id IS NULL
        ORDER BY appointment.appointment_id LIMIT 1`,
		[ownNote.userId],
	);
	appointmentWithoutNote = appointments.rows[0];
});

beforeEach(async () => {
	await api.query("BEGIN");
});

afterEach(async () => {
	await api.query("ROLLBACK");
});

afterAll(async () => {
	await api.end();
	await setup.end();
});

async function setLocalProfile(profileName: string) {
	const actor =
		profileName === "healthcare_professional"
			? ownNote
			: users.find((user) => user.clinicId === localContact.clinicId && user.role === profileName)!;
	await api.query(
		"SELECT pg_catalog.set_config('app.user_id', $1, true), pg_catalog.set_config('app.clinic_id', $2, true)",
		[actor.userId, actor.clinicId],
	);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	return actor.userId;
}

function contactValues(userId: string, action = "read") {
	return [localContact.clinicId, userId, localContact.patientId, "patient_contact", null, action];
}

function noteValues(note: AuditReference, userId: string, action = "read") {
	return [note.clinicId, userId, note.patientId, "clinical_note", note.appointmentId, action];
}

it("reads all audit events from the administrator's context clinic", async () => {
	await setLocalProfile("clinic_administrator");
	const { rows } = await setup.query<Pick<AuditRecord, "clinicId">>(readQuery);
	expect(rows.some((record) => record.clinicId !== localContact.clinicId)).toBe(true);
	expect((await api.query(readQuery)).rows).toEqual(
		rows.filter((record) => record.clinicId === localContact.clinicId),
	);
});

it("filters an explicit foreign clinic from audit reads", async () => {
	await setLocalProfile("clinic_administrator");
	expect(
		(await api.query("SELECT * FROM public.audit_records WHERE clinic_id = $1::uuid", [foreignContact.clinicId]))
			.rows,
	).toEqual([]);
});

it.each([...excludedProfiles, "reception", "healthcare_professional"])(
	"denies audit reads to %s",
	async (profileName) => {
		await setLocalProfile("clinic_administrator");
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		await expect(api.query(readQuery)).rejects.toMatchObject(permissionDenied);
	},
);

it.each(excludedProfiles)("denies audit insertion to %s", async (profileName) => {
	const userId = await setLocalProfile("clinic_administrator");
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	await expect(api.query(insertQuery, contactValues(userId))).rejects.toMatchObject(permissionDenied);
});

it.each(clinicProfiles.flatMap((profileName) => ["read", "write"].map((action) => ({ profileName, action }))))(
	"allows $profileName to insert a patient contact $action event",
	async ({ profileName, action }) => {
		const userId = await setLocalProfile(profileName);
		expect((await api.query(insertQuery, contactValues(userId, action))).rowCount).toBe(1);
	},
);

it("generates the audit identifier and timestamp from database defaults", async () => {
	const userId = await setLocalProfile("clinic_administrator");
	const inserted = await api.query(insertQuery + " RETURNING audit_record_id, occurred_at", contactValues(userId));
	expect(inserted.rows).toEqual([{ audit_record_id: expect.any(String), occurred_at: expect.any(Date) }]);
});

it.each(["reception", "healthcare_professional"])("denies audit INSERT RETURNING to %s", async (profileName) => {
	const userId = await setLocalProfile(profileName);
	await expect(api.query(insertQuery + " RETURNING audit_record_id", contactValues(userId))).rejects.toMatchObject(
		permissionDenied,
	);
});

it.each(clinicProfiles)("rejects a patient contact event with a different actor for %s", async (profileName) => {
	const userId = await setLocalProfile(profileName);
	const otherUserId = userId === localContact.userId ? ownNote.userId : localContact.userId;
	await expect(api.query(insertQuery, contactValues(otherUserId))).rejects.toMatchObject(rlsViolation);
});

it("rejects a patient contact event outside the context clinic", async () => {
	await setLocalProfile("reception");
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [foreignContact.userId]);
	const { clinicId, userId, patientId } = foreignContact;
	await expect(
		api.query(insertQuery, [clinicId, userId, patientId, "patient_contact", null, "read"]),
	).rejects.toMatchObject(rlsViolation);
});

it("rejects a foreign patient identifier in a local contact event", async () => {
	const userId = await setLocalProfile("reception");
	const values = [localContact.clinicId, userId, foreignContact.patientId, "patient_contact", null, "read"];
	await expect(api.query(insertQuery, values)).rejects.toMatchObject({
		code: "23503",
		constraint: "audit_records_clinic_id_patient_id_fkey",
	});
});

it("rejects a note reference on a patient contact event", async () => {
	const userId = await setLocalProfile("reception");
	const values = [localContact.clinicId, userId, ownNote.patientId, "patient_contact", ownNote.appointmentId, "read"];
	await expect(api.query(insertQuery, values)).rejects.toMatchObject({
		code: "23514",
		constraint: "audit_records_resource_check",
	});
});

it.each(["read", "write"])(
	"allows a healthcare professional to insert an owned clinical note %s event",
	async (action) => {
		const userId = await setLocalProfile("healthcare_professional");
		expect((await api.query(insertQuery, noteValues(ownNote, userId, action))).rowCount).toBe(1);
	},
);

it.each(["clinic_administrator", "reception"])("rejects clinical note audit insertion by %s", async (profileName) => {
	const userId = await setLocalProfile(profileName);
	await expect(api.query(insertQuery, noteValues(ownNote, userId))).rejects.toMatchObject(rlsViolation);
});

it("rejects a clinical note event attributed to another local professional", async () => {
	await setLocalProfile("healthcare_professional");
	await expect(api.query(insertQuery, noteValues(otherNote, otherNote.userId))).rejects.toMatchObject(rlsViolation);
});

it("rejects an event for a clinical note owned by another local professional", async () => {
	const userId = await setLocalProfile("healthcare_professional");
	await expect(api.query(insertQuery, noteValues(otherNote, userId))).rejects.toMatchObject(rlsViolation);
});

it("rejects a foreign clinical note under the local audit clinic", async () => {
	const userId = await setLocalProfile("healthcare_professional");
	const values = noteValues({ ...foreignNote, clinicId: ownNote.clinicId }, userId);
	await expect(api.query(insertQuery, values)).rejects.toMatchObject(rlsViolation);
});

it("rejects an owned clinical note event outside the context clinic", async () => {
	const userId = await setLocalProfile("healthcare_professional");
	await api.query("SELECT pg_catalog.set_config('app.clinic_id', $1, true)", [foreignContact.clinicId]);
	await expect(api.query(insertQuery, noteValues(ownNote, userId))).rejects.toMatchObject(rlsViolation);
});

it("rejects an owned clinical note event with a different local patient", async () => {
	const userId = await setLocalProfile("healthcare_professional");
	const values = noteValues({ ...ownNote, patientId: otherNote.patientId }, userId);
	await expect(api.query(insertQuery, values)).rejects.toMatchObject(rlsViolation);
});

it("requires an existing note for a matching clinical note event", async () => {
	const userId = await setLocalProfile("healthcare_professional");
	await expect(
		api.query(insertQuery, noteValues({ ...ownNote, ...appointmentWithoutNote }, userId)),
	).rejects.toMatchObject({ code: "23503", constraint: "audit_records_clinic_id_appointment_id_fkey" });
});

it.each(
	clinicProfiles.flatMap((profileName) =>
		["audit_record_id", "occurred_at"].map((column) => ({ profileName, column })),
	),
)("denies an explicit $column in audit inserts by $profileName", async ({ profileName, column }) => {
	const userId = await setLocalProfile(profileName);
	const query = `INSERT INTO public.audit_records (${insertColumns.join(", ")}, ${escapeIdentifier(column)})
            VALUES ($1::uuid, $2::uuid, $3::uuid, $4::public.audit_resource, $5::uuid, $6::public.audit_action, DEFAULT)`;
	await expect(api.query(query, contactValues(userId))).rejects.toMatchObject(permissionDenied);
});

it.each(invalidContexts)("restricts audit reads with $label", async ({ field, value, malformed }) => {
	await setLocalProfile("clinic_administrator");
	await api.query("SELECT pg_catalog.set_config($1, $2, true)", [field, value]);
	const result = api.query(readQuery);
	if (malformed) {
		await expect(result).rejects.toMatchObject({ code: "22P02" });
	} else {
		expect((await result).rows).toEqual([]);
	}
});

it.each(invalidContexts)("rejects audit insertion with $label", async ({ field, value, malformed }) => {
	const userId = await setLocalProfile("reception");
	await api.query("SELECT pg_catalog.set_config($1, $2, true)", [field, value]);
	await expect(api.query(insertQuery, contactValues(userId))).rejects.toMatchObject(
		malformed ? { code: "22P02" } : rlsViolation,
	);
});

it("limits effective audit access to administrator reads and six insert columns for clinic profiles", async () => {
	const roles = [
		...clinicProfiles,
		...excludedProfiles,
		"medical_data_hub_identity_owner",
		"medical_data_hub_metadata_owner",
		"medical_data_hub_locking_owner",
	];
	const { rows } = await setup.query(
		`SELECT role_name AS "roleName",
            pg_catalog.has_any_column_privilege(role_name, 'public.audit_records', 'SELECT') AS "canRead",
            pg_catalog.has_table_privilege(role_name, 'public.audit_records', 'INSERT') AS "canInsertTable",
            ARRAY(SELECT column_name::text FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'audit_records'
                    AND pg_catalog.has_column_privilege(role_name, 'public.audit_records', column_name, 'INSERT')
                ORDER BY column_name) AS "insertColumns"
        FROM unnest($1::text[]) WITH ORDINALITY AS roles(role_name, position)
        ORDER BY position`,
		[roles],
	);
	expect(rows).toEqual(
		roles.map((roleName) => ({
			roleName,
			canRead: roleName === "clinic_administrator",
			canInsertTable: false,
			insertColumns: clinicProfiles.includes(roleName) ? insertColumns.toSorted() : [],
		})),
	);
});
