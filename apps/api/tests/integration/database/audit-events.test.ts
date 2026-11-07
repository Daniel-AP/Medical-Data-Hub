import { Client, Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { insertAuditEvent } from "../../../src/database/audit-events.js";
import { runTransaction } from "../../../src/database/transaction.js";
import type { AuditRecord } from "../../../src/generated/prisma/client.js";

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

it.each([
	{ resource: "patient_contact", action: "read", selectRole: "SET LOCAL ROLE reception" },
	{ resource: "clinical_note", action: "write", selectRole: "SET LOCAL ROLE healthcare_professional" },
] as const)("commits a $resource $action event with authorized metadata", async ({ resource, action, selectRole }) => {
	const {
		rows: [fixture],
	} = await setup.query<Pick<AuditRecord, "clinicId" | "userId" | "patientId" | "appointmentId">>(
		`SELECT clinic_id AS "clinicId", user_id AS "userId", patient_id AS "patientId", appointment_id AS "appointmentId"
		 FROM public.audit_records WHERE resource = $1::public.audit_resource ORDER BY audit_record_id LIMIT 1`,
		[resource],
	);
	const { clinicId, userId, patientId, appointmentId } = fixture;

	const transactionId = await runTransaction(
		"readCommitted",
		async (client) => {
			await client.query(
				"SELECT pg_catalog.set_config('app.user_id', $1, true), pg_catalog.set_config('app.clinic_id', $2, true)",
				[userId, clinicId],
			);
			await client.query(selectRole);
			const target =
				resource === "clinical_note"
					? { resource, patientId, appointmentId: appointmentId! }
					: { resource, patientId };
			await insertAuditEvent(client, { clinicId, userId }, target, action);

			const { rows } = await client.query<{ transactionId: string }>(
				'SELECT pg_catalog.pg_current_xact_id()::xid::text AS "transactionId"',
			);
			return rows[0].transactionId;
		},
		pool,
	);

	const { rows } = await setup.query(
		`SELECT audit_record_id AS "auditRecordId", clinic_id AS "clinicId", user_id AS "userId",
		        patient_id AS "patientId", resource, appointment_id AS "appointmentId", action, occurred_at AS "occurredAt"
		 FROM public.audit_records WHERE xmin = $1::xid`,
		[transactionId],
	);
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
