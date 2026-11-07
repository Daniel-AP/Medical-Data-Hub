import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createAuditReadRecorder, insertAuditEvent } from "../../../src/database/audit-events.js";
import { runTransaction } from "../../../src/database/transaction.js";
import type { TransactionClient } from "../../../src/database/types.js";
import type { AuditRecord, ClinicalNote, Patient } from "../../../src/generated/prisma/client.js";

type AuditFixture = Pick<AuditRecord, "clinicId" | "userId" | "patientId" | "appointmentId">;
type Contact = Pick<Patient, "patientId" | "email" | "phone">;

const setupConnectionString = process.env.DATABASE_SETUP_URL;
const apiConnectionString = process.env.DATABASE_URL;
if (!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const pool = new Pool({ connectionString: apiConnectionString });

beforeAll(async () => {
	await setup.connect();
});

afterAll(async () => {
	await pool.end();
	await setup.end();
});

async function readAuditFixture(resource: "patient_contact" | "clinical_note") {
	const {
		rows: [fixture],
	} = await setup.query<AuditFixture>(
		`SELECT clinic_id AS "clinicId", user_id AS "userId", patient_id AS "patientId", appointment_id AS "appointmentId"
		 FROM public.audit_records WHERE resource = $1::public.audit_resource ORDER BY audit_record_id LIMIT 1`,
		[resource],
	);
	return fixture;
}

async function runAuditPhase<T>(
	{ clinicId, userId }: AuditFixture,
	selectRole: string,
	operation: (client: TransactionClient) => Promise<T>,
) {
	return runTransaction(
		"readCommitted",
		async (client) => {
			await client.query(
				"SELECT pg_catalog.set_config('app.user_id', $1, true), pg_catalog.set_config('app.clinic_id', $2, true)",
				[userId, clinicId],
			);
			await client.query(selectRole);

			const result = await operation(client);
			const { rows } = await client.query<{ transactionId: string }>(
				'SELECT pg_catalog.pg_current_xact_id()::xid::text AS "transactionId"',
			);
			return { result, transactionId: rows[0].transactionId };
		},
		pool,
	);
}

async function readCommittedEvents(transactionId: string) {
	const { rows } = await setup.query(
		`SELECT audit_record_id AS "auditRecordId", clinic_id AS "clinicId", user_id AS "userId",
		        patient_id AS "patientId", resource, appointment_id AS "appointmentId", action, occurred_at AS "occurredAt"
		 FROM public.audit_records WHERE xmin = $1::xid ORDER BY patient_id`,
		[transactionId],
	);
	return rows;
}

function readContact(client: TransactionClient, patientId: string) {
	return client.query<Contact>(
		'SELECT patient_id AS "patientId", email, phone FROM public.patients WHERE patient_id = $1::uuid',
		[patientId],
	);
}

it.each([
	{ resource: "patient_contact", action: "read", selectRole: "SET LOCAL ROLE reception" },
	{ resource: "clinical_note", action: "write", selectRole: "SET LOCAL ROLE healthcare_professional" },
] as const)("commits a $resource $action event with authorized metadata", async ({ resource, action, selectRole }) => {
	const actor = await readAuditFixture(resource);
	const { clinicId, userId, patientId, appointmentId } = actor;
	const target =
		resource === "clinical_note" ? { resource, patientId, appointmentId: appointmentId! } : { resource, patientId };
	const { transactionId } = await runAuditPhase(actor, selectRole, (client) =>
		insertAuditEvent(client, actor, target, action),
	);

	const rows = await readCommittedEvents(transactionId);
	expect(rows).toEqual([
		{
			auditRecordId: expect.any(String),
			clinicId,
			userId,
			patientId,
			resource,
			appointmentId,
			action,
			occurredAt: expect.any(Date),
		},
	]);
});

it("records one read per distinct patient contact across queries in the same attempt", async () => {
	const actor = await readAuditFixture("patient_contact");
	const { result, transactionId } = await runAuditPhase(actor, "SET LOCAL ROLE reception", async (client) => {
		const recordReads = createAuditReadRecorder(client, actor);
		const { rows } = await client.query<Contact>(
			'SELECT patient_id AS "patientId", email, phone FROM public.patients ORDER BY patient_id LIMIT 2',
		);
		await recordReads(rows.map(({ patientId }) => ({ resource: "patient_contact", patientId })));

		const repeated = await readContact(client, rows[0].patientId);
		expect(repeated.rowCount).toBe(1);
		await recordReads(repeated.rows.map(({ patientId }) => ({ resource: "patient_contact", patientId })));
		return rows;
	});

	expect(result).toHaveLength(2);
	expect(result.every(({ email, phone }) => Boolean(email || phone))).toBe(true);
	expect(await readCommittedEvents(transactionId)).toMatchObject(
		result.map(({ patientId }) => ({
			clinicId: actor.clinicId,
			userId: actor.userId,
			patientId,
			resource: "patient_contact",
			appointmentId: null,
			action: "read",
		})),
	);
});

it("records a clinical note read with the patient from its appointment", async () => {
	const actor = await readAuditFixture("clinical_note");
	const { result, transactionId } = await runAuditPhase(
		actor,
		"SET LOCAL ROLE healthcare_professional",
		async (client) => {
			const recordReads = createAuditReadRecorder(client, actor);
			const { rows } = await client.query<
				Pick<ClinicalNote, "appointmentId" | "content"> & Pick<Patient, "patientId">
			>(
				`SELECT note.appointment_id AS "appointmentId", appointment.patient_id AS "patientId", note.content
			 FROM public.clinical_notes AS note
			 JOIN public.appointments AS appointment USING (clinic_id, appointment_id)
			 WHERE note.appointment_id = $1::uuid`,
				[actor.appointmentId],
			);
			await recordReads(
				rows.map(({ appointmentId, patientId }) => ({ resource: "clinical_note", appointmentId, patientId })),
			);
			return rows;
		},
	);

	expect(result).toHaveLength(1);
	expect(result[0].content.length).toBeGreaterThan(0);
	expect(await readCommittedEvents(transactionId)).toMatchObject([
		{
			clinicId: actor.clinicId,
			userId: actor.userId,
			patientId: actor.patientId,
			resource: "clinical_note",
			appointmentId: actor.appointmentId,
			action: "read",
		},
	]);
});

it("commits no read events for an empty contact result", async () => {
	const actor = await readAuditFixture("patient_contact");
	const { result, transactionId } = await runAuditPhase(actor, "SET LOCAL ROLE reception", async (client) => {
		const recordReads = createAuditReadRecorder(client, actor);
		const { rows } = await readContact(client, randomUUID());
		await recordReads(rows.map(({ patientId }) => ({ resource: "patient_contact", patientId })));
		return rows;
	});

	expect(result).toHaveLength(0);
	expect(await readCommittedEvents(transactionId)).toEqual([]);
});
