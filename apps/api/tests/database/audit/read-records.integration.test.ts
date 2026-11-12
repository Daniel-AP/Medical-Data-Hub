import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readAuditRecords } from "../../../src/database/audit-records.js";
import type { AuditRecord, User } from "../../../src/generated/prisma/client.js";
import { UserRole } from "../../../src/generated/prisma/enums.js";

type AuditActor = Pick<User, "userId"> & { clinicId: NonNullable<User["clinicId"]> };
type ClinicAdmin = Pick<AuditActor, "clinicId"> & Pick<User, "identityId">;
type ContactEvent = Omit<AuditRecord, "resource"> & { resource: "patient_contact" };

const setupConnectionString = process.env.DATABASE_SETUP_URL;
const apiConnectionString = process.env.DATABASE_URL;
if(!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const pool = new Pool({ connectionString: apiConnectionString, max: 1 });
const patientId = randomUUID();
const otherPatientId = randomUUID();
const from = new Date("2000-01-01T10:00:00.123Z");
const tiedAt = new Date("2000-01-01T11:00:00.000Z");
const to = new Date("2000-01-01T12:00:00.123Z");
let administrator: ClinicAdmin;
let startEvent: ContactEvent;
let tiedEvents: ContactEvent[];
let endEvent: ContactEvent;
let otherUserEvent: ContactEvent;
let otherPatientEvent: ContactEvent;

beforeAll(async () => {

	await setup.connect();
	const { rows: [clinicAdmin] } = await setup.query<ClinicAdmin>(`
		SELECT clinic_id AS "clinicId", identity_id AS "identityId"
		FROM public.users WHERE role = 'clinic_administrator' ORDER BY clinic_id LIMIT 1
	`);
	administrator = clinicAdmin;
	const { rows: actors } = await setup.query<AuditActor & { role: string }>(
		`SELECT user_id AS "userId", clinic_id AS "clinicId", role FROM public.users
		 WHERE clinic_id = $1::uuid AND role IN ('reception', 'healthcare_professional')
		 ORDER BY user_id`,
		[administrator.clinicId],
	);
	const actor = actors.find(({ clinicId, role }) => clinicId === administrator.clinicId && role === "reception")!;
	const otherActor = actors.find(
		({ clinicId, role }) => clinicId === administrator.clinicId && role === "healthcare_professional",
	)!;
	await setup.query(
		`INSERT INTO public.patients (patient_id, clinic_id, identification, name, date_of_birth, email)
		 VALUES ($1::uuid, $3::uuid, $1::text, 'Synthetic patient', '1990-05-15', 'audit-query@example.test'),
		        ($2::uuid, $3::uuid, $2::text, 'Synthetic patient', '1990-05-15', 'audit-query@example.test')`,
		[patientId, otherPatientId, administrator.clinicId],
	);

	startEvent = await insertContactEvent(actor, patientId, from);
	tiedEvents = [
		await insertContactEvent(actor, patientId, tiedAt),
		await insertContactEvent(actor, patientId, tiedAt),
	].sort((left, right) => right.auditRecordId.localeCompare(left.auditRecordId));
	endEvent = await insertContactEvent(actor, patientId, to);
	otherUserEvent = await insertContactEvent(otherActor, patientId, new Date("2000-01-01T11:30:00Z"));
	otherPatientEvent = await insertContactEvent(actor, otherPatientId, new Date("2000-01-01T11:15:00Z"));

});

afterAll(async () => {
	await pool.end();
	await setup.end();
});

const insertContactEvent = async (actor: AuditActor, patientId: string, occurredAt: Date): Promise<ContactEvent> => {

	const {
		rows: [{ auditRecordId }],
	} = await setup.query<Pick<AuditRecord, "auditRecordId">>(
		`INSERT INTO public.audit_records (clinic_id, user_id, patient_id, resource, action, occurred_at)
		 VALUES ($1::uuid, $2::uuid, $3::uuid, 'patient_contact', 'read', $4::timestamptz)
		 RETURNING audit_record_id AS "auditRecordId"`,
		[actor.clinicId, actor.userId, patientId, occurredAt],
	);

	return {
		auditRecordId,
		clinicId: actor.clinicId,
		userId: actor.userId,
		patientId,
		resource: "patient_contact",
		appointmentId: null,
		action: "read",
		occurredAt,
	};

};

const readForAdmin = (actor: ClinicAdmin, filters: Parameters<typeof readAuditRecords>[1]) => {
	return readAuditRecords({ identityId: actor.identityId, roles: [UserRole.clinicAdministrator] }, filters, pool);
};

it("filters audit records by user, patient, or date range independently", async () => {

	const { userId } = startEvent;
	const userRecords = await readForAdmin(administrator, { userId });
	expect(userRecords).toEqual(expect.arrayContaining([endEvent, otherPatientEvent, ...tiedEvents, startEvent]));
	expect(new Set(userRecords.map((record) => record.userId))).toEqual(new Set([userId]));
	expect(await readForAdmin(administrator, { patientId })).toEqual([
		endEvent,
		otherUserEvent,
		...tiedEvents,
		startEvent,
	]);
	expect(await readForAdmin(administrator, { from, to })).toEqual([
		otherUserEvent,
		otherPatientEvent,
		...tiedEvents,
		startEvent,
	]);

});
