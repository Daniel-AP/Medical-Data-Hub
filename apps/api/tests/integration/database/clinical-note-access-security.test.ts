import { setTimeout } from "node:timers/promises";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { Appointment, ClinicalNote, Professional, User } from "../../../src/generated/prisma/client.js";

type LocalUser = Pick<User, "userId" | "clinicId"> & { role: string };
type NoteAppointment = Pick<
	Appointment,
	"appointmentId" | "clinicId" | "professionalId" | "patientId" | "serviceId" | "startAt" | "endAt" | "state"
>;

const setupConnectionString = process.env.DATABASE_SETUP_URL;
const apiConnectionString = process.env.DATABASE_URL;
if (!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const api = new Client({ connectionString: apiConnectionString });
const contender = new Client({ connectionString: apiConnectionString });
const profileNames = ["clinic_administrator", "reception", "healthcare_professional"];
const insertQuery =
	"INSERT INTO public.clinical_notes (appointment_id, clinic_id, content) VALUES ($1::uuid, $2::uuid, $3)";
const appointmentInsertQuery = `INSERT INTO public.appointments (clinic_id, patient_id, professional_id, service_id, start_at, end_at, state, cancelled_by_user_id, cancellation_reason)
    VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz, $6::timestamptz, $7::public.appointment_state, $8::uuid, $9) RETURNING appointment_id`;
let administrator: LocalUser;
let actor: LocalUser;
let professional: Professional;
let appointments: NoteAppointment[];
let notes: ClinicalNote[];
let otherNote: ClinicalNote;
let foreignNote: ClinicalNote;
let fixtureAppointmentId: string;
let appointmentValues: (string | Date)[];

beforeAll(async () => {
	await setup.connect();
	await api.connect();
	await contender.connect();
	const users = await setup.query<LocalUser>(`
        SELECT user_id AS "userId", clinic_id AS "clinicId", role::text
        FROM public.users ORDER BY clinic_id NULLS LAST, user_id
    `);
	administrator = users.rows.find((user) => user.role === "clinic_administrator")!;
	actor = users.rows.find(
		(user) => user.role === "healthcare_professional" && user.clinicId === administrator.clinicId,
	)!;
	const professionals = await setup.query<Professional>(`
        SELECT professional_id AS "professionalId", clinic_id AS "clinicId", user_id AS "userId", specialty_id AS "specialtyId"
        FROM public.professionals ORDER BY professional_id
    `);
	professional = professionals.rows.find((profile) => profile.userId === actor.userId)!;
	const appointmentResult = await setup.query<NoteAppointment>(`
        SELECT appointment_id AS "appointmentId", clinic_id AS "clinicId", professional_id AS "professionalId", patient_id AS "patientId",
            service_id AS "serviceId", start_at AS "startAt", end_at AS "endAt", state
        FROM public.appointments ORDER BY appointment_id
    `);
	appointments = appointmentResult.rows;
	const noteResult = await setup.query<ClinicalNote>(`
        SELECT appointment_id AS "appointmentId", clinic_id AS "clinicId", content FROM public.clinical_notes ORDER BY appointment_id
    `);
	notes = noteResult.rows;
	const ownAppointment = appointments.find(
		(appointment) => appointment.professionalId === professional.professionalId && appointment.state === "attended",
	)!;
	otherNote = notes.find(
		(note) =>
			note.clinicId === actor.clinicId &&
			appointments.some(
				(appointment) =>
					appointment.appointmentId === note.appointmentId &&
					appointment.professionalId !== professional.professionalId,
			),
	)!;
	foreignNote = notes.find((note) => note.clinicId !== actor.clinicId)!;
	const startAt = new Date("2020-01-06T15:00:00.000Z");
	const endAt = new Date(startAt.getTime() + (ownAppointment.endAt.getTime() - ownAppointment.startAt.getTime()));
	appointmentValues = [
		ownAppointment.clinicId,
		ownAppointment.patientId,
		ownAppointment.professionalId,
		ownAppointment.serviceId,
		startAt,
		endAt,
	];
	const fixture = await setup.query(appointmentInsertQuery, [...appointmentValues, "attended", null, null]);
	fixtureAppointmentId = fixture.rows[0].appointment_id;
});

beforeEach(async () => {
	await api.query("BEGIN ISOLATION LEVEL READ COMMITTED");
	await api.query(
		`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
		[actor.userId, actor.clinicId],
	);
	await api.query("SET LOCAL ROLE healthcare_professional");
});

afterEach(async () => {
	await contender.query("ROLLBACK");
	await api.query("ROLLBACK");
});

afterAll(async () => {
	await setup.query("DELETE FROM public.clinical_notes WHERE appointment_id = $1::uuid", [fixtureAppointmentId]);
	await setup.query("DELETE FROM public.appointments WHERE appointment_id = $1::uuid", [fixtureAppointmentId]);
	await contender.end();
	await api.end();
	await setup.end();
});

it("reads only clinical notes belonging to the context professional", async () => {
	const { rows } = await api.query(`
        SELECT appointment_id AS "appointmentId", clinic_id AS "clinicId", content FROM public.clinical_notes ORDER BY appointment_id
    `);
	expect(rows).toEqual(
		notes.filter(
			(note) =>
				note.clinicId === actor.clinicId &&
				appointments.some(
					(appointment) =>
						appointment.appointmentId === note.appointmentId &&
						appointment.professionalId === professional.professionalId,
				),
		),
	);
});

it("inserts a clinical note for an owned attended appointment", async () => {
	const inserted = await api.query(insertQuery + " RETURNING appointment_id, clinic_id", [
		fixtureAppointmentId,
		actor.clinicId,
		"Synthetic clinical note",
	]);
	expect(inserted.rows).toEqual([{ appointment_id: fixtureAppointmentId, clinic_id: actor.clinicId }]);
	const { rows } = await api.query("SELECT content FROM public.clinical_notes WHERE appointment_id = $1::uuid", [
		fixtureAppointmentId,
	]);
	expect(rows).toEqual([{ content: "Synthetic clinical note" }]);
});

it("rejects clinical note insertion for owned reserved appointments", async () => {
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [administrator.userId]);
	await api.query("SET LOCAL ROLE clinic_administrator");
	const appointment = await api.query(appointmentInsertQuery, [...appointmentValues, "reserved", null, null]);
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query("SET LOCAL ROLE healthcare_professional");
	await expect(
		api.query(insertQuery, [appointment.rows[0].appointment_id, actor.clinicId, "Synthetic clinical note"]),
	).rejects.toMatchObject({
		code: "42501",
		message: 'new row violates row-level security policy for table "clinical_notes"',
	});
});

it("rejects clinical note insertion for another professional in the same clinic", async () => {
	await expect(
		api.query(insertQuery, [otherNote.appointmentId, actor.clinicId, "Synthetic clinical note"]),
	).rejects.toMatchObject({
		code: "42501",
		message: 'new row violates row-level security policy for table "clinical_notes"',
	});
});

it("rejects a foreign appointment identifier under the local note clinic", async () => {
	await expect(
		api.query(insertQuery, [foreignNote.appointmentId, actor.clinicId, "Synthetic clinical note"]),
	).rejects.toMatchObject({
		code: "42501",
		message: 'new row violates row-level security policy for table "clinical_notes"',
	});
});

it("resolves concurrent clinical note inserts after the first writer's COMMIT", async () => {
	await api.query(insertQuery, [fixtureAppointmentId, actor.clinicId, "First synthetic note"]);
	const apiPid = (await api.query("SELECT pg_catalog.pg_backend_pid() AS pid")).rows[0].pid;
	await contender.query("BEGIN ISOLATION LEVEL READ COMMITTED");
	await contender.query("SET LOCAL lock_timeout = '3s'");
	await contender.query(
		`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
		[actor.userId, actor.clinicId],
	);
	await contender.query("SET LOCAL ROLE healthcare_professional");
	const contenderPid = (await contender.query("SELECT pg_catalog.pg_backend_pid() AS pid")).rows[0].pid;
	const pendingInsert = contender
		.query(insertQuery, [fixtureAppointmentId, actor.clinicId, "Second synthetic note"])
		.catch((error: unknown) => error);
	try {
		let isWaiting = false;
		for (let attempt = 0; attempt < 100; attempt++) {
			const { rows } = await setup.query(
				"SELECT $2::int = ANY(pg_catalog.pg_blocking_pids($1::int)) AS waiting",
				[contenderPid, apiPid],
			);
			if (rows[0].waiting) {
				isWaiting = true;
				break;
			}
			await setTimeout(10);
		}
		expect(isWaiting).toBe(true);
		await api.query("COMMIT");
		expect(await pendingInsert).toMatchObject({ code: "23505", constraint: "clinical_notes_pkey" });
		const stored = await setup.query("SELECT content FROM public.clinical_notes WHERE appointment_id = $1::uuid", [
			fixtureAppointmentId,
		]);
		expect(stored.rows).toEqual([{ content: "First synthetic note" }]);
	} finally {
		await api.query("ROLLBACK");
		await pendingInsert;
		await contender.query("ROLLBACK");
		await setup.query("DELETE FROM public.clinical_notes WHERE appointment_id = $1::uuid", [fixtureAppointmentId]);
	}
});

it("grants only clinical note SELECT and INSERT to healthcare professionals", async () => {
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
        WHERE table_schema = 'public' AND table_name = 'clinical_notes' AND grantee = ANY($1::text[])
        ORDER BY grantee, privilege_type`,
		[roles],
	);
	expect(tableGrants.rows).toEqual([
		{ grantee: "healthcare_professional", privilege_type: "INSERT", is_grantable: "NO" },
		{ grantee: "healthcare_professional", privilege_type: "SELECT", is_grantable: "NO" },
	]);
	const updateGrants = await setup.query(
		`SELECT grantee, column_name, is_grantable FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = 'clinical_notes' AND grantee = ANY($1::text[]) AND privilege_type = 'UPDATE'`,
		[roles],
	);
	expect(updateGrants.rows).toEqual([]);
});
