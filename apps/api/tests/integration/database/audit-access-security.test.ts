import { Client, escapeIdentifier } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { AuditRecord, User } from "../../../src/generated/prisma/client.js";

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

let localContact: AuditReference;
let foreignContact: AuditReference;
let ownNote: AuditReference;
let otherNote: AuditReference;
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
	users = (
		await setup.query<LocalUser>(
			'SELECT clinic_id AS "clinicId", user_id AS "userId", role::text FROM public.users',
		)
	).rows;
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

const setLocalProfile = async (profileName: string) => {
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
};

const contactValues = (userId: string, action = "read") => {
	return [localContact.clinicId, userId, localContact.patientId, "patient_contact", null, action];
};

const noteValues = (note: AuditReference, userId: string, action = "read") => {
	return [note.clinicId, userId, note.patientId, "clinical_note", note.appointmentId, action];
};

it("reads all audit events from the administrator's context clinic", async () => {
	await setLocalProfile("clinic_administrator");
	const { rows } = await setup.query<Pick<AuditRecord, "clinicId">>(readQuery);
	expect(rows.some((record) => record.clinicId !== localContact.clinicId)).toBe(true);
	expect((await api.query(readQuery)).rows).toEqual(
		rows.filter((record) => record.clinicId === localContact.clinicId),
	);
});

it("allows reception to insert a patient contact read event", async () => {
	const { profileName, action } = { profileName: "reception", action: "read" };
	const userId = await setLocalProfile(profileName);
	expect((await api.query(insertQuery, contactValues(userId, action))).rowCount).toBe(1);
});

it("rejects a patient contact event with a different actor for reception", async () => {
	const profileName = "reception";
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

it("allows a healthcare professional to insert an owned clinical note write event", async () => {
	const action = "write";
	const userId = await setLocalProfile("healthcare_professional");
	expect((await api.query(insertQuery, noteValues(ownNote, userId, action))).rowCount).toBe(1);
});

it("rejects clinical note audit insertion by clinic_administrator", async () => {
	const profileName = "clinic_administrator";
	const userId = await setLocalProfile(profileName);
	await expect(api.query(insertQuery, noteValues(ownNote, userId))).rejects.toMatchObject(rlsViolation);
});

it("rejects an event for a clinical note owned by another local professional", async () => {
	const userId = await setLocalProfile("healthcare_professional");
	await expect(api.query(insertQuery, noteValues(otherNote, userId))).rejects.toMatchObject(rlsViolation);
});

it("rejects an owned clinical note event with a different local patient", async () => {
	const userId = await setLocalProfile("healthcare_professional");
	const values = noteValues({ ...ownNote, patientId: otherNote.patientId }, userId);
	await expect(api.query(insertQuery, values)).rejects.toMatchObject(rlsViolation);
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
