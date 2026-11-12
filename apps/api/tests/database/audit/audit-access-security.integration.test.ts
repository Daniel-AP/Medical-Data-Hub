import { Client, escapeIdentifier } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { AuditRecord, User } from "../../../src/generated/prisma/client.js";

type LocalUser = Pick<User, "userId" | "clinicId"> & { role: string };
type AuditReference = Pick<AuditRecord, "clinicId" | "userId" | "patientId" | "appointmentId">;

const setupConnectionString = process.env.DATABASE_SETUP_URL;
const apiConnectionString = process.env.DATABASE_URL;
if(!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const api = new Client({ connectionString: apiConnectionString });
const insertColumns = ["clinic_id", "user_id", "patient_id", "resource", "appointment_id", "action"];
const insertQuery = `INSERT INTO public.audit_records (${insertColumns.join(", ")})
    VALUES ($1::uuid, $2::uuid, $3::uuid, $4::public.audit_resource, $5::uuid, $6::public.audit_action)`;
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

it("rejects an owned clinical note event with a different local patient", async () => {
	const userId = await setLocalProfile("healthcare_professional");
	const values = noteValues({ ...ownNote, patientId: otherNote.patientId }, userId);
	await expect(api.query(insertQuery, values)).rejects.toMatchObject(rlsViolation);
});
