import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
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
const pool = new Pool({ connectionString: apiConnectionString, max: 1 });

beforeAll(async () => {
	await setup.connect();
});

afterAll(async () => {
	await pool.end();
	await setup.end();
});

const readAuditFixture = async (resource: "patient_contact" | "clinical_note") => {
	const {
		rows: [fixture],
	} = await setup.query<AuditFixture>(
		`SELECT record.clinic_id AS "clinicId", record.user_id AS "userId", record.patient_id AS "patientId",
		        record.appointment_id AS "appointmentId"
		 FROM public.audit_records AS record JOIN public.users AS actor USING (clinic_id, user_id)
		 WHERE record.resource = $1::public.audit_resource AND actor.role = $2::public.user_role
		 ORDER BY record.audit_record_id LIMIT 1`,
		[resource, resource === "patient_contact" ? "reception" : "healthcare_professional"],
	);
	return fixture;
};

const runAuditPhase = async <T>(
	{ clinicId, userId }: AuditFixture,
	selectRole: string,
	operation: (client: TransactionClient) => Promise<T>,
) => {
	return runTransaction(
		"readCommitted",
		async (client) => {
			await client.query(
				"SELECT pg_catalog.set_config('app.user_id', $1, true), pg_catalog.set_config('app.clinic_id', $2, true)",
				[userId, clinicId],
			);
			await client.query(selectRole);

			const result = await operation(client);
			return { result, transactionId: await readTransactionId(client) };
		},
		pool,
	);
};

const readTransactionId = async (client: TransactionClient) => {
	const { rows } = await client.query<{ transactionId: string }>(
		'SELECT pg_catalog.pg_current_xact_id()::xid::text AS "transactionId"',
	);
	return rows[0].transactionId;
};

const readCommittedEvents = async (transactionId: string) => {
	const { rows } = await setup.query(
		`SELECT audit_record_id AS "auditRecordId", clinic_id AS "clinicId", user_id AS "userId",
		        patient_id AS "patientId", resource, appointment_id AS "appointmentId", action, occurred_at AS "occurredAt"
		 FROM public.audit_records WHERE xmin = $1::xid ORDER BY patient_id, action`,
		[transactionId],
	);
	return rows;
};

const readContact = (client: TransactionClient, patientId: string) => {
	return client.query<Contact>(
		'SELECT patient_id AS "patientId", email, phone FROM public.patients WHERE patient_id = $1::uuid',
		[patientId],
	);
};

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

it("rejects retrieved contact content when the audit insert is denied", async () => {
	const actor = await readAuditFixture("patient_contact");
	const phase = runAuditPhase(actor, "SET LOCAL ROLE reception", async (client) => {
		const recordReads = createAuditReadRecorder(client, actor);
		const { rows } = await readContact(client, actor.patientId);
		expect(rows.length).toBe(1);
		expect(Boolean(rows[0].email || rows[0].phone)).toBe(true);

		await client.query("RESET ROLE");
		await recordReads(rows.map(({ patientId }) => ({ resource: "patient_contact", patientId })));
		return rows;
	});

	await expect(phase.then(({ result }) => result.length)).rejects.toMatchObject({
		stage: "operation",
		kind: "database",
		sqlState: "42501",
	});
});

it("rolls back a contact update and its read and write events after a rejection", async () => {
	const actor = await readAuditFixture("patient_contact");
	const { patientId } = actor;
	const original = (await readContact(setup, patientId)).rows[0];
	const updatedEmail = `${randomUUID()}@example.test`;
	const rejection = Object.assign(new Error("Controlled rejection after audit inserts"), { status: 409 });
	let transactionId = "";

	const phase = runAuditPhase(actor, "SET LOCAL ROLE reception", async (client) => {
		const recordReads = createAuditReadRecorder(client, actor);
		const { rows } = await readContact(client, patientId);
		expect(rows.length).toBe(1);
		await recordReads(rows.map(({ patientId }) => ({ resource: "patient_contact", patientId })));

		const update = await client.query("UPDATE public.patients SET email = $1 WHERE patient_id = $2::uuid", [
			updatedEmail,
			patientId,
		]);
		expect(update.rowCount).toBe(1);
		await insertAuditEvent(client, actor, { resource: "patient_contact", patientId }, "write");
		transactionId = await readTransactionId(client);
		throw rejection;
	});

	await expect(phase).rejects.toBe(rejection);
	const stored = (await readContact(setup, patientId)).rows[0];
	expect(stored.email === original.email && stored.phone === original.phone).toBe(true);
	expect(await readCommittedEvents(transactionId)).toEqual([]);
});

it("withholds audited contact content without retry when commit confirmation is lost", async () => {
	const actor = await readAuditFixture("patient_contact");
	const connection = await pool.connect();
	const query = connection.query.bind(connection);
	const lostConfirmation = new Error("Synthetic loss of commit confirmation");
	const interceptedQuery = vi.spyOn(connection, "query").mockImplementation((...args: unknown[]) => {
		if (args[0] === "COMMIT") {
			return query("COMMIT").then((commit) => {
				expect(commit.command).toBe("COMMIT");
				throw lostConfirmation;
			});
		}
		return Reflect.apply(query, connection, args);
	});
	connection.release();

	let transactionId = "";
	const read = vi.fn(async (client: TransactionClient) => {
		const recordReads = createAuditReadRecorder(client, actor);
		const { rows } = await readContact(client, actor.patientId);
		expect(rows.length).toBe(1);
		expect(Boolean(rows[0].email || rows[0].phone)).toBe(true);
		await recordReads(rows.map(({ patientId }) => ({ resource: "patient_contact", patientId })));
		transactionId = await readTransactionId(client);
		return rows;
	});

	try {
		const phase = runAuditPhase(actor, "SET LOCAL ROLE reception", read);
		await expect(phase.then(({ result }) => result.length)).rejects.toMatchObject({
			stage: "commit",
			kind: "indeterminateCommit",
			cause: lostConfirmation,
		});
		expect(read).toHaveBeenCalledTimes(1);
		expect(await readCommittedEvents(transactionId)).toMatchObject([
			{
				clinicId: actor.clinicId,
				userId: actor.userId,
				patientId: actor.patientId,
				resource: "patient_contact",
				appointmentId: null,
				action: "read",
			},
		]);
	} finally {
		interceptedQuery.mockRestore();
	}
});

it("commits a new patient and its contact write event together", async () => {
	const actor = await readAuditFixture("patient_contact");
	const identification = randomUUID();
	const email = `${identification}@example.test`;
	const { result, transactionId } = await runAuditPhase(actor, "SET LOCAL ROLE reception", async (client) => {
		const {
			rows: [patient],
		} = await client.query<Pick<Patient, "patientId">>(
			`INSERT INTO public.patients (clinic_id, identification, name, date_of_birth, email)
			 VALUES ($1::uuid, $2, 'Synthetic patient', '1990-05-15', $3) RETURNING patient_id AS "patientId"`,
			[actor.clinicId, identification, email],
		);
		await insertAuditEvent(client, actor, { resource: "patient_contact", patientId: patient.patientId }, "write");
		return patient;
	});

	expect(result).toEqual({ patientId: expect.any(String) });
	const patient = await setup.query(
		"SELECT 1 FROM public.patients WHERE patient_id = $1::uuid AND email = $2 AND xmin = $3::xid",
		[result.patientId, email, transactionId],
	);
	expect(patient.rowCount).toBe(1);
	expect(await readCommittedEvents(transactionId)).toMatchObject([
		{
			clinicId: actor.clinicId,
			userId: actor.userId,
			patientId: result.patientId,
			resource: "patient_contact",
			appointmentId: null,
			action: "write",
		},
	]);
});

it("commits a new clinical note and its write event together", async () => {
	const actor = await readAuditFixture("clinical_note");
	const {
		rows: [{ appointmentId }],
	} = await setup.query<Pick<ClinicalNote, "appointmentId">>(
		`INSERT INTO public.appointments (clinic_id, patient_id, professional_id, service_id, start_at, end_at, state)
		 SELECT clinic_id, patient_id, professional_id, service_id, $2::timestamptz,
		        $2::timestamptz + (end_at - start_at), 'attended'
		 FROM public.appointments WHERE appointment_id = $1::uuid
		 RETURNING appointment_id AS "appointmentId"`,
		[actor.appointmentId, "2020-02-03T15:00:00Z"],
	);
	const content = "Synthetic note for the audit write test";
	const { result, transactionId } = await runAuditPhase(
		actor,
		"SET LOCAL ROLE healthcare_professional",
		async (client) => {
			const {
				rows: [{ patientId }],
			} = await client.query<Pick<Patient, "patientId">>(
				'SELECT patient_id AS "patientId" FROM public.appointments WHERE appointment_id = $1::uuid',
				[appointmentId],
			);
			const {
				rows: [note],
			} = await client.query<Pick<ClinicalNote, "appointmentId">>(
				`INSERT INTO public.clinical_notes (appointment_id, clinic_id, content)
				 VALUES ($1::uuid, $2::uuid, $3) RETURNING appointment_id AS "appointmentId"`,
				[appointmentId, actor.clinicId, content],
			);
			await insertAuditEvent(client, actor, { resource: "clinical_note", appointmentId, patientId }, "write");
			return note;
		},
	);

	expect(result).toEqual({ appointmentId });
	const note = await setup.query(
		"SELECT 1 FROM public.clinical_notes WHERE appointment_id = $1::uuid AND content = $2 AND xmin = $3::xid",
		[appointmentId, content, transactionId],
	);
	expect(note.rowCount).toBe(1);
	expect(await readCommittedEvents(transactionId)).toMatchObject([
		{
			clinicId: actor.clinicId,
			userId: actor.userId,
			patientId: actor.patientId,
			resource: "clinical_note",
			appointmentId,
			action: "write",
		},
	]);
});

it.each([
	{ label: "an unchanged email assignment", assignsContact: true, actions: ["read", "write"] },
	{ label: "a name-only edit", assignsContact: false, actions: ["read"] },
])("commits the expected contact audit events for $label", async ({ assignsContact, actions }) => {
	const actor = await readAuditFixture("patient_contact");
	const { patientId } = actor;
	const original = (await readContact(setup, patientId)).rows[0];
	const name = `Synthetic name ${randomUUID()}`;
	const { result, transactionId } = await runAuditPhase(actor, "SET LOCAL ROLE reception", async (client) => {
		const recordReads = createAuditReadRecorder(client, actor);
		const { rows } = await readContact(client, patientId);
		expect(rows.length).toBe(1);
		expect(Boolean(rows[0].email || rows[0].phone)).toBe(true);
		await recordReads(rows.map(({ patientId }) => ({ resource: "patient_contact", patientId })));

		const statement = assignsContact
			? 'UPDATE public.patients SET email = $1 WHERE patient_id = $2::uuid RETURNING patient_id AS "patientId"'
			: 'UPDATE public.patients SET name = $1 WHERE patient_id = $2::uuid RETURNING patient_id AS "patientId"';
		const update = await client.query<Pick<Patient, "patientId">>(statement, [
			assignsContact ? original.email : name,
			patientId,
		]);
		if (assignsContact) {
			await insertAuditEvent(client, actor, { resource: "patient_contact", patientId }, "write");
		}
		return update.rows[0];
	});

	expect(result).toEqual({ patientId });
	const patient = await setup.query(
		`SELECT 1 FROM public.patients WHERE patient_id = $1::uuid AND xmin = $2::xid
		 AND email IS NOT DISTINCT FROM $3 AND phone IS NOT DISTINCT FROM $4
		 AND ($5::text IS NULL OR name = $5)`,
		[patientId, transactionId, original.email, original.phone, assignsContact ? null : name],
	);
	expect(patient.rowCount).toBe(1);
	expect(await readCommittedEvents(transactionId)).toMatchObject(
		actions.map((action) => ({
			clinicId: actor.clinicId,
			userId: actor.userId,
			patientId,
			resource: "patient_contact",
			appointmentId: null,
			action,
		})),
	);
});
