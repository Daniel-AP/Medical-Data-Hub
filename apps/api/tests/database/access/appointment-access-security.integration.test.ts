import { Client, escapeIdentifier } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { Appointment, Professional, User } from "../../../src/generated/prisma/client.js";

type LocalUser = Pick<User, "userId" | "clinicId"> & { role: string };

const setupConnectionString = process.env.DATABASE_SETUP_URL;
const apiConnectionString = process.env.DATABASE_URL;
if(!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const api = new Client({ connectionString: apiConnectionString });
const insertQuery = `INSERT INTO public.appointments (clinic_id, patient_id, professional_id, service_id, start_at, end_at)
    VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz, $6::timestamptz)`;
let users: LocalUser[];
let administrator: LocalUser;
let appointments: Appointment[];
let target: Appointment;
let foreignAppointment: Appointment;
let startAt: Date;
let endAt: Date;

beforeAll(async () => {

	await setup.connect();
	await api.connect();
	const userResult = await setup.query<LocalUser>(`
        SELECT user_id AS "userId", clinic_id AS "clinicId", role::text
        FROM public.users ORDER BY clinic_id NULLS LAST, user_id
    `);
	users = userResult.rows;
	administrator = users.find((user) => user.role === "clinic_administrator")!;
	const professionalActor = users.find(
		(user) => user.role === "healthcare_professional" && user.clinicId === administrator.clinicId,
	)!;
	const professional = await setup.query<Pick<Professional, "professionalId">>(
		'SELECT professional_id AS "professionalId" FROM public.professionals WHERE user_id = $1::uuid',
		[professionalActor.userId],
	);
	const appointmentResult = await setup.query<Appointment>(`
        SELECT appointment_id AS "appointmentId", clinic_id AS "clinicId", patient_id AS "patientId",
            professional_id AS "professionalId", service_id AS "serviceId", start_at AS "startAt", end_at AS "endAt", state,
            previous_appointment_id AS "previousAppointmentId", cancelled_by_user_id AS "cancelledByUserId", cancellation_reason AS "cancellationReason"
        FROM public.appointments ORDER BY appointment_id
    `);
	appointments = appointmentResult.rows;
	target = appointments.find(
		(appointment) =>
			appointment.professionalId === professional.rows[0].professionalId && appointment.state === "reserved",
	)!;
	foreignAppointment = appointments.find((appointment) => appointment.clinicId !== administrator.clinicId)!;
	startAt = new Date("2030-01-07T15:00:00.000Z");
	endAt = new Date(startAt.getTime()+(target.endAt.getTime()-target.startAt.getTime()));

});

beforeEach(async () => {

	await api.query("BEGIN");
	await api.query(
		`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
		[administrator.userId, administrator.clinicId],
	);
	await api.query("SET LOCAL ROLE clinic_administrator");

});

afterEach(async () => {
	await api.query("ROLLBACK");
});

afterAll(async () => {
	await api.end();
	await setup.end();
});

it("reads only same-clinic appointment records as reception", async () => {

	const profileName = "reception";
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	const { rows } = await api.query(`
        SELECT appointment_id AS "appointmentId", clinic_id AS "clinicId", patient_id AS "patientId",
            professional_id AS "professionalId", service_id AS "serviceId", start_at AS "startAt", end_at AS "endAt", state,
            previous_appointment_id AS "previousAppointmentId", cancelled_by_user_id AS "cancelledByUserId", cancellation_reason AS "cancellationReason"
        FROM public.appointments ORDER BY appointment_id
    `);
	expect(rows).toEqual(appointments.filter((appointment) => appointment.clinicId === actor.clinicId));

});

it("rejects foreign-clinic appointment inserts through RLS as reception", async () => {

	const profileName = "reception";
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	await expect(
		api.query(insertQuery, [
			foreignAppointment.clinicId,
			foreignAppointment.patientId,
			foreignAppointment.professionalId,
			foreignAppointment.serviceId,
			startAt,
			endAt,
		]),
	).rejects.toMatchObject({
		code: "42501",
		message: 'new row violates row-level security policy for table "appointments"',
	});

});

it("rejects foreign-clinic patient references during appointment insertion as reception", async () => {

	const actor = users.find((user) => user.role === "reception" && user.clinicId === administrator.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query("SET LOCAL ROLE reception");
	const values = [
		target.clinicId,
		foreignAppointment.patientId,
		target.professionalId,
		target.serviceId,
		startAt,
		endAt,
	];
	await expect(api.query(insertQuery, values)).rejects.toMatchObject({
		code: "23503",
		constraint: "appointments_clinic_id_patient_id_fkey",
	});

});
