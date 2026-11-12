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
if(!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const api = new Client({ connectionString: apiConnectionString });
const profileNames = ["clinic_administrator", "reception", "healthcare_professional"];
const insertQuery =
	"INSERT INTO public.clinical_notes (appointment_id, clinic_id, content) VALUES ($1::uuid, $2::uuid, $3)";
let administrator: LocalUser;
let actor: LocalUser;
let professional: Professional;
let appointments: NoteAppointment[];
let notes: ClinicalNote[];
let foreignNote: ClinicalNote;

beforeAll(async () => {

	await setup.connect();
	await api.connect();
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
	foreignNote = notes.find((note) => note.clinicId !== actor.clinicId)!;

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
	await api.query("ROLLBACK");
});

afterAll(async () => {
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

it("rejects a foreign appointment identifier under the local note clinic", async () => {

	await expect(
		api.query(insertQuery, [foreignNote.appointmentId, actor.clinicId, "Synthetic clinical note"]),
	).rejects.toMatchObject({
		code: "42501",
		message: 'new row violates row-level security policy for table "clinical_notes"',
	});

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
