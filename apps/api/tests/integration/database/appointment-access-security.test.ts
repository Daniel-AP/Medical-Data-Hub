import { Client, escapeIdentifier } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { Appointment, Professional, User } from "../../../src/generated/prisma/client.js";

type LocalUser = Pick<User, "userId" | "clinicId"> & { role: string };

const setupConnectionString = process.env.DATABASE_SETUP_URL;
const apiConnectionString = process.env.DATABASE_URL;
if (!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const api = new Client({ connectionString: apiConnectionString });
const profileNames = ["clinic_administrator", "reception", "healthcare_professional"];
const insertQuery = `INSERT INTO public.appointments (clinic_id, patient_id, professional_id, service_id, start_at, end_at)
    VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz, $6::timestamptz)`;
const replacementQuery = `INSERT INTO public.appointments (clinic_id, patient_id, professional_id, service_id, start_at, end_at, previous_appointment_id)
    VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz, $6::timestamptz, $7::uuid)`;
let users: LocalUser[];
let administrator: LocalUser;
let appointments: Appointment[];
let target: Appointment;
let foreignAppointment: Appointment;
let startAt: Date;
let endAt: Date;
let appointmentValues: (string | Date)[];

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
	endAt = new Date(startAt.getTime() + (target.endAt.getTime() - target.startAt.getTime()));
	appointmentValues = [target.clinicId, target.patientId, target.professionalId, target.serviceId, startAt, endAt];
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

it("allows appointment insertion and the three editable fields as reception", async () => {
	const profileName = "reception";
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	const inserted = await api.query(insertQuery + " RETURNING *", appointmentValues);
	expect(inserted.rows).toEqual([
		{
			appointment_id: expect.any(String),
			clinic_id: target.clinicId,
			patient_id: target.patientId,
			professional_id: target.professionalId,
			service_id: target.serviceId,
			start_at: startAt,
			end_at: endAt,
			state: "reserved",
			previous_appointment_id: null,
			cancelled_by_user_id: null,
			cancellation_reason: null,
		},
	]);
	const updated = await api.query(
		`UPDATE public.appointments SET state = 'cancelled', cancelled_by_user_id = $2::uuid, cancellation_reason = $3
        WHERE appointment_id = $1::uuid RETURNING *`,
		[inserted.rows[0].appointment_id, actor.userId, "Synthetic cancellation"],
	);
	expect(updated.rows).toEqual([
		{
			...inserted.rows[0],
			state: "cancelled",
			cancelled_by_user_id: actor.userId,
			cancellation_reason: "Synthetic cancellation",
		},
	]);
});

it("allows healthcare professionals to update state to attended", async () => {
	const state = "attended";
	const pastStart = new Date("2020-01-06T15:00:00.000Z");
	const pastEnd = new Date(pastStart.getTime() + (endAt.getTime() - startAt.getTime()));
	const inserted = await api.query(insertQuery + " RETURNING *", [
		target.clinicId,
		target.patientId,
		target.professionalId,
		target.serviceId,
		pastStart,
		pastEnd,
	]);
	const actor = users.find(
		(user) => user.role === "healthcare_professional" && user.clinicId === administrator.clinicId,
	)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query("SET LOCAL ROLE healthcare_professional");
	const updated = await api.query(
		"UPDATE public.appointments SET state = $2::public.appointment_state WHERE appointment_id = $1::uuid RETURNING *",
		[inserted.rows[0].appointment_id, state],
	);
	expect(updated.rows).toEqual([{ ...inserted.rows[0], state }]);
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

it("filters foreign appointment state updates as healthcare_professional", async () => {
	const profileName = "healthcare_professional";
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	const result = await api.query("UPDATE public.appointments SET state = state WHERE appointment_id = $1::uuid", [
		foreignAppointment.appointmentId,
	]);
	expect(result.rowCount).toBe(0);
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

it("preserves the unique replacement appointment reference as reception", async () => {
	const profileName = "reception";
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	const original = await api.query(insertQuery + " RETURNING appointment_id", appointmentValues);
	await api.query("UPDATE public.appointments SET state = 'rescheduled' WHERE appointment_id = $1::uuid", [
		original.rows[0].appointment_id,
	]);
	const values = [
		target.clinicId,
		target.patientId,
		target.professionalId,
		target.serviceId,
		new Date(startAt.getTime() + 86400000),
		new Date(endAt.getTime() + 86400000),
		original.rows[0].appointment_id,
	];
	expect((await api.query(replacementQuery, values)).rowCount).toBe(1);
	await expect(api.query(replacementQuery, values)).rejects.toMatchObject({
		code: "23505",
		constraint: "appointments_previous_key",
	});
});

it("rejects missing cancellation reasons during appointment UPDATE as reception", async () => {
	const actor = users.find((user) => user.role === "reception" && user.clinicId === administrator.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query("SET LOCAL ROLE reception");
	await expect(
		api.query(
			"UPDATE public.appointments SET state = 'cancelled', cancelled_by_user_id = $2::uuid WHERE appointment_id = $1::uuid",
			[target.appointmentId, actor.userId],
		),
	).rejects.toMatchObject({ code: "23514", constraint: "appointments_cancellation_check" });
});

it("grants only the designed appointment table and column privileges", async () => {
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
        WHERE table_schema = 'public' AND table_name = 'appointments' AND grantee = ANY($1::text[])
        ORDER BY grantee, privilege_type`,
		[roles],
	);
	expect(tableGrants.rows).toEqual([
		{ grantee: "clinic_administrator", privilege_type: "INSERT", is_grantable: "NO" },
		{ grantee: "clinic_administrator", privilege_type: "SELECT", is_grantable: "NO" },
		{ grantee: "healthcare_professional", privilege_type: "SELECT", is_grantable: "NO" },
		{ grantee: "reception", privilege_type: "INSERT", is_grantable: "NO" },
		{ grantee: "reception", privilege_type: "SELECT", is_grantable: "NO" },
	]);
	const updateGrants = await setup.query(
		`SELECT grantee, column_name, is_grantable FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = 'appointments' AND grantee = ANY($1::text[]) AND privilege_type = 'UPDATE'
        ORDER BY grantee, column_name`,
		[roles],
	);
	expect(updateGrants.rows).toEqual([
		...["cancellation_reason", "cancelled_by_user_id", "state"].map((columnName) => ({
			grantee: "clinic_administrator",
			column_name: columnName,
			is_grantable: "NO",
		})),
		{ grantee: "healthcare_professional", column_name: "state", is_grantable: "NO" },
		...["cancellation_reason", "cancelled_by_user_id", "state"].map((columnName) => ({
			grantee: "reception",
			column_name: columnName,
			is_grantable: "NO",
		})),
	]);
	const metadataGrants = await setup.query(`
        SELECT column_name, privilege_type, is_grantable FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = 'appointments' AND grantee = 'medical_data_hub_metadata_owner'
        ORDER BY column_name, privilege_type
    `);
	expect(metadataGrants.rows).toEqual(
		["appointment_id", "clinic_id", "patient_id", "professional_id", "service_id"].map((columnName) => ({
			column_name: columnName,
			privilege_type: "SELECT",
			is_grantable: "NO",
		})),
	);
});
