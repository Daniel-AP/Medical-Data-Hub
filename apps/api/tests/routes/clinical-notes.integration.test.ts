import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { decodeJwt } from "jose";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

const apiUrl = process.env.CLINICAL_NOTE_TEST_API_URL;
const setupUrl = process.env.CLINICAL_NOTE_TEST_DATABASE_SETUP_URL;
const professionalToken = process.env.CLINICAL_NOTE_TEST_PROFESSIONAL_TOKEN;
const receptionToken = process.env.CLINICAL_NOTE_TEST_RECEPTION_TOKEN;
if(!apiUrl || !setupUrl || !professionalToken || !receptionToken) {
	throw new Error("Configure the clinical note test API, disposable database setup URL, and Keycloak tokens");
}

const setup = new Pool({ connectionString: setupUrl });
const content = "  Synthetic note.\n";
let actor: { userId: string; clinicId: string; professionalId: string };

const postNote = (appointmentId: string, body: object, token = professionalToken) => {

	return fetch(new URL(`/appointments/${appointmentId}/clinical-note`, apiUrl), {
		method: "POST",
		headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(body),
	});

};

const getNote = (appointmentId: string, token = professionalToken, headers: Record<string, string> = {}) => {

	return fetch(new URL(`/appointments/${appointmentId}/clinical-note`, apiUrl), {
		headers: { ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
	});

};

const createAppointment = async (state: "attended" | "reserved" = "attended") => {

	const appointmentId = randomUUID();
	const { rows: [appointment] } = await setup.query<{ patientId: string }>(
		`INSERT INTO public.appointments (appointment_id, clinic_id, professional_id, patient_id, service_id, start_at, end_at, state)
		 SELECT $1::uuid, clinic_id, professional_id, patient_id, service_id, start_at, end_at, $2::public.appointment_state
		 FROM public.appointments WHERE clinic_id = $3::uuid AND professional_id = $4::uuid
		 AND state = 'attended' ORDER BY appointment_id LIMIT 1
		 RETURNING patient_id AS "patientId"`,
		[appointmentId, state, actor.clinicId, actor.professionalId],
	);

	return { appointmentId, patientId: appointment.patientId };

};

const createStoredNote = async () => {

	const appointment = await createAppointment();
	await setup.query(
		"INSERT INTO public.clinical_notes (appointment_id, clinic_id, content) VALUES ($1, $2, $3)",
		[appointment.appointmentId, actor.clinicId, content],
	);

	return appointment;

};

const rejectNoteAudit = (appointmentId: string, action: "read" | "write") => setup.query(`
	CREATE FUNCTION public.reject_test_clinical_note_audit() RETURNS trigger
	LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic audit failure'; END; $$;
	CREATE TRIGGER reject_test_clinical_note_audit BEFORE INSERT ON public.audit_records
	FOR EACH ROW WHEN (NEW.appointment_id = '${appointmentId}'::uuid AND NEW.action = '${action}')
	EXECUTE FUNCTION public.reject_test_clinical_note_audit();
`);

const restoreNoteAudit = () => setup.query(`
	DROP TRIGGER reject_test_clinical_note_audit ON public.audit_records;
	DROP FUNCTION public.reject_test_clinical_note_audit();
`);

beforeAll(async () => {

	const { rows } = await setup.query<typeof actor>(
		`SELECT users.user_id AS "userId", users.clinic_id AS "clinicId", professional_id AS "professionalId"
		 FROM public.users JOIN public.professionals USING (clinic_id, user_id)
		 WHERE identity_id = $1`,
		[decodeJwt(professionalToken).sub],
	);
	expect(rows).toHaveLength(1);
	actor = rows[0];

});

afterAll(async () => {
	await setup.end();
});

it("requires a valid token and the healthcare professional role to create a clinical note", async () => {

	const appointmentId = randomUUID();
	expect((await postNote(appointmentId, { content }, "")).status).toBe(401);
	expect((await postNote(appointmentId, { content }, receptionToken)).status).toBe(403);

});

it("rejects invalid appointment identifiers and clinical note bodies", async () => {

	const appointmentId = randomUUID();
	expect((await postNote("invalid", { content })).status).toBe(400);
	for(const body of [{ content: " \n" }, { content: "invalid\0text" }, { content, clinicId: actor.clinicId }, {}]) {
		expect((await postNote(appointmentId, body)).status).toBe(400);
	}

});

it("creates a clinical note and commits a write event containing only attributed metadata", async () => {

	const { appointmentId, patientId } = await createAppointment();
	const response = await postNote(appointmentId, { content });
	expect(response.status).toBe(201);
	expect(await response.json()).toEqual({ appointmentId, created: true });

	const note = await setup.query("SELECT content FROM public.clinical_notes WHERE appointment_id = $1", [appointmentId]);
	expect(note.rows).toEqual([{ content }]);

	const audit = await setup.query("SELECT * FROM public.audit_records WHERE appointment_id = $1", [appointmentId]);
	expect(audit.rows).toEqual([{
		audit_record_id: expect.any(String),
		clinic_id: actor.clinicId,
		user_id: actor.userId,
		patient_id: patientId,
		resource: "clinical_note",
		appointment_id: appointmentId,
		action: "write",
		occurred_at: expect.any(Date),
	}]);

});

it("rejects a clinical note for a reserved appointment without saving a note", async () => {

	const { appointmentId } = await createAppointment("reserved");
	expect((await postNote(appointmentId, { content })).status).toBe(409);
	const note = await setup.query("SELECT appointment_id FROM public.clinical_notes WHERE appointment_id = $1", [appointmentId]);
	expect(note.rows).toEqual([]);

});

it("responds identically for missing appointments and appointments outside the treating professional's scope", async () => {

	const { rows } = await setup.query<{ appointmentId: string }>(
		`SELECT DISTINCT ON (clinic_id = $1::uuid) appointment_id AS "appointmentId"
		 FROM public.appointments WHERE professional_id <> $2::uuid AND state = 'attended'
		 ORDER BY clinic_id = $1::uuid, appointment_id`,
		[actor.clinicId, actor.professionalId],
	);
	expect(rows).toHaveLength(2);
	const missing = await postNote(randomUUID(), { content });
	expect(missing.status).toBe(404);
	const missingBody: unknown = await missing.json();

	for(const { appointmentId } of rows) {
		const response = await postNote(appointmentId, { content });
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual(missingBody);
	}

});

it("keeps one original note and one write event when two creation requests race", async () => {

	const { appointmentId } = await createAppointment();
	const contents = ["First synthetic note.", "Second synthetic note."];
	const blocker = await setup.connect();
	let requests: Promise<Response>[] = [];
	try {

		await blocker.query("BEGIN");
		await blocker.query("LOCK TABLE public.clinical_notes IN SHARE MODE");
		const { rows: [{ pid }] } = await blocker.query<{ pid: number }>("SELECT pg_catalog.pg_backend_pid() AS pid");
		requests = contents.map((content) => postNote(appointmentId, { content }));

		let waiting = 0;
		for(let attempt = 0; attempt < 100 && waiting !== 2; attempt++) {

			const { rows: [result] } = await setup.query<{ waiting: number }>(
				`SELECT count(DISTINCT pid)::int AS waiting FROM pg_catalog.pg_locks
				 WHERE relation = 'public.clinical_notes'::regclass AND mode = 'RowExclusiveLock' AND NOT granted
				 AND $1::int = ANY(pg_catalog.pg_blocking_pids(pid))`,
				[pid],
			);
			waiting = result.waiting;
			if(waiting !== 2) {
				await setTimeout(10);
			}

		}
		expect(waiting).toBe(2);

	} finally {

		await blocker.query("ROLLBACK");
		blocker.release();
		await Promise.allSettled(requests);

	}

	const responses = await Promise.all(requests);
	expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
	const winner = responses.findIndex(({ status }) => status === 201);
	expect(await responses[1-winner].json()).toEqual({ error: "Conflict" });
	const note = await setup.query("SELECT content FROM public.clinical_notes WHERE appointment_id = $1", [appointmentId]);
	expect(note.rows).toEqual([{ content: contents[winner] }]);
	const audit = await setup.query("SELECT action FROM public.audit_records WHERE appointment_id = $1", [appointmentId]);
	expect(audit.rows).toEqual([{ action: "write" }]);

});

it("rolls back clinical note creation when the write audit event fails", async () => {

	const { appointmentId } = await createAppointment();
	await rejectNoteAudit(appointmentId, "write");
	try {

		const response = await postNote(appointmentId, { content });
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "Internal Server Error" });
		const note = await setup.query("SELECT appointment_id FROM public.clinical_notes WHERE appointment_id = $1", [appointmentId]);
		expect(note.rows).toEqual([]);
		const audit = await setup.query("SELECT action FROM public.audit_records WHERE appointment_id = $1", [appointmentId]);
		expect(audit.rows).toEqual([]);

	} finally {
		await restoreNoteAudit();
	}

});

it("requires valid authorization and an appointment UUID to retrieve a clinical note", async () => {

	const appointmentId = randomUUID();
	expect((await getNote(appointmentId, "")).status).toBe(401);
	expect((await getNote(appointmentId, receptionToken)).status).toBe(403);
	expect((await getNote("invalid")).status).toBe(400);

});

it("returns clinical note content without caching after committing an attributed read event", async () => {

	const { appointmentId, patientId } = await createStoredNote();
	const response = await getNote(appointmentId, professionalToken, { "If-None-Match": "*", "Cache-Control": "max-age=0" });
	expect(response.status).toBe(200);
	expect(response.headers.get("Cache-Control")).toBe("no-store");
	expect(response.headers.get("ETag")).toBeNull();
	expect(await response.json()).toEqual({ appointmentId, content });

	const audit = await setup.query("SELECT * FROM public.audit_records WHERE appointment_id = $1", [appointmentId]);
	expect(audit.rows).toEqual([{
		audit_record_id: expect.any(String),
		clinic_id: actor.clinicId,
		user_id: actor.userId,
		patient_id: patientId,
		resource: "clinical_note",
		appointment_id: appointmentId,
		action: "read",
		occurred_at: expect.any(Date),
	}]);

});

it("returns the same not-found response without recording a read for missing and out-of-scope notes", async () => {

	const { appointmentId } = await createAppointment();
	const { rows } = await setup.query<{ appointmentId: string }>(
		`SELECT DISTINCT ON (clinic_id = $1::uuid) appointment_id AS "appointmentId"
		 FROM public.clinical_notes JOIN public.appointments USING (clinic_id, appointment_id)
		 WHERE professional_id <> $2::uuid
		 ORDER BY clinic_id = $1::uuid, appointment_id`,
		[actor.clinicId, actor.professionalId],
	);
	expect(rows).toHaveLength(2);
	const appointmentIds = [randomUUID(), appointmentId, ...rows.map(({ appointmentId }) => appointmentId)];
	const countReads = () => setup.query(
		"SELECT count(*) FROM public.audit_records WHERE appointment_id = ANY($1::uuid[]) AND action = 'read'",
		[appointmentIds],
	);
	const before = await countReads();

	for(const targetId of appointmentIds) {

		const response = await getNote(targetId);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Not Found" });

	}

	const after = await countReads();
	expect(after.rows).toEqual(before.rows);

});

it("withholds clinical note content when the read audit event fails", async () => {

	const { appointmentId } = await createStoredNote();
	await rejectNoteAudit(appointmentId, "read");
	try {

		const response = await getNote(appointmentId);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "Internal Server Error" });
		const audit = await setup.query("SELECT action FROM public.audit_records WHERE appointment_id = $1", [appointmentId]);
		expect(audit.rows).toEqual([]);

	} finally {
		await restoreNoteAudit();
	}

});
