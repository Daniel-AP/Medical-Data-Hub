import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Appointment, Professional, User } from "../../../src/generated/prisma/client.js";

type Actor = Pick<User, "userId" | "clinicId">;
type ProfessionalMetadata = Pick<Professional, "professionalId" | "userId" | "clinicId">;
type AppointmentMetadata = Pick<Appointment, "appointmentId" | "professionalId" | "patientId" | "serviceId">;

const setupConnectionString = process.env.DATABASE_SETUP_URL;
const apiConnectionString = process.env.DATABASE_URL;
if(!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const api = new Client({ connectionString: apiConnectionString });
let actor: Actor;
let otherActor: Actor;
let platform: Actor;
let professional: ProfessionalMetadata;
let otherProfessional: ProfessionalMetadata;
let appointment: AppointmentMetadata;
let otherAppointment: AppointmentMetadata;

beforeAll(async () => {

	await setup.connect();
	await api.connect();
	const actors = await setup.query<Actor>(`
        SELECT user_id AS "userId", clinic_id AS "clinicId"
        FROM public.users WHERE role = 'reception' ORDER BY clinic_id, user_id
    `);
	[actor, otherActor] = actors.rows;
	const platformResult = await setup.query<Actor>(`
        SELECT user_id AS "userId", clinic_id AS "clinicId"
        FROM public.users WHERE role = 'platform_administrator' ORDER BY user_id LIMIT 1
    `);
	platform = platformResult.rows[0];

	const professionalResult = await setup.query<ProfessionalMetadata>(
		`
        SELECT professional_id AS "professionalId", user_id AS "userId", clinic_id AS "clinicId"
        FROM public.professionals WHERE clinic_id = $1::uuid ORDER BY professional_id LIMIT 1
    `,
		[actor.clinicId],
	);
	professional = professionalResult.rows[0];
	const otherProfessionalResult = await setup.query<ProfessionalMetadata>(
		`
        SELECT professional_id AS "professionalId", user_id AS "userId", clinic_id AS "clinicId"
        FROM public.professionals WHERE clinic_id = $1::uuid ORDER BY professional_id LIMIT 1
    `,
		[otherActor.clinicId],
	);
	otherProfessional = otherProfessionalResult.rows[0];

	const appointmentResult = await setup.query<AppointmentMetadata>(
		`
        SELECT appointment_id AS "appointmentId", professional_id AS "professionalId",
               patient_id AS "patientId", service_id AS "serviceId"
        FROM public.appointments WHERE professional_id = $1::uuid AND state = 'attended'
        ORDER BY appointment_id LIMIT 1
    `,
		[professional.professionalId],
	);
	appointment = appointmentResult.rows[0];
	const otherAppointmentResult = await setup.query<AppointmentMetadata>(
		`
        SELECT appointment_id AS "appointmentId", professional_id AS "professionalId",
               patient_id AS "patientId", service_id AS "serviceId"
        FROM public.appointments WHERE professional_id = $1::uuid AND state = 'attended'
        ORDER BY appointment_id LIMIT 1
    `,
		[otherProfessional.professionalId],
	);
	otherAppointment = otherAppointmentResult.rows[0];

});

afterAll(async () => {
	await api.end();
	await setup.end();
});

it("filters a professional belonging to another clinic", async () => {

	const { rows } = await api.query("SELECT * FROM public.resolve_professional_user($1::uuid, $2::uuid)", [
		actor.userId,
		otherProfessional.professionalId,
	]);
	expect(rows).toEqual([]);

});

it("filters an appointment belonging to another clinic", async () => {

	const { rows } = await api.query("SELECT * FROM public.resolve_appointment_references($1::uuid, $2::uuid)", [
		actor.userId,
		otherAppointment.appointmentId,
	]);
	expect(rows).toEqual([]);

});

it("gives no appointment metadata to a platform actor with a NULL clinic", async () => {

	const { rows } = await api.query("SELECT * FROM public.resolve_appointment_references($1::uuid, $2::uuid)", [
		platform.userId,
		appointment.appointmentId,
	]);
	expect(rows).toEqual([]);

});
