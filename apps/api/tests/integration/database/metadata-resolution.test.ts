import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Appointment, Professional, User } from "../../../src/generated/prisma/client.js";

type Actor = Pick<User, "userId" | "clinicId">;
type ProfessionalMetadata = Pick<Professional, "professionalId" | "userId" | "clinicId">;
type AppointmentMetadata = Pick<Appointment, "appointmentId" | "professionalId" | "patientId" | "serviceId">;

const setupConnectionString = process.env.DATABASE_SETUP_URL;
const apiConnectionString = process.env.DATABASE_URL;
if (!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const api = new Client({ connectionString: apiConnectionString });
const functionCalls = [
	["resolve_actor_professional", "SELECT * FROM public.resolve_actor_professional(NULL::uuid)"],
	["resolve_professional_user", "SELECT * FROM public.resolve_professional_user(NULL::uuid, NULL::uuid)"],
	["resolve_appointment_references", "SELECT * FROM public.resolve_appointment_references(NULL::uuid, NULL::uuid)"],
] as const;
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

it("resolves only the actor's own professional identifier", async () => {
	const result = await api.query("SELECT * FROM public.resolve_actor_professional($1::uuid)", [professional.userId]);
	expect(result.fields.map((field) => field.name)).toEqual(["professional_id"]);
	expect(result.rows).toEqual([{ professional_id: professional.professionalId }]);
});

it("resolves only a same-clinic professional's user identifier", async () => {
	const result = await api.query("SELECT * FROM public.resolve_professional_user($1::uuid, $2::uuid)", [
		actor.userId,
		professional.professionalId,
	]);
	expect(result.fields.map((field) => field.name)).toEqual(["user_id"]);
	expect(result.rows).toEqual([{ user_id: professional.userId }]);
});

it("filters a professional belonging to another clinic", async () => {
	const { rows } = await api.query("SELECT * FROM public.resolve_professional_user($1::uuid, $2::uuid)", [
		actor.userId,
		otherProfessional.professionalId,
	]);
	expect(rows).toEqual([]);
});

it("resolves only the professional, patient, and service references of a same-clinic appointment", async () => {
	const result = await api.query("SELECT * FROM public.resolve_appointment_references($1::uuid, $2::uuid)", [
		actor.userId,
		appointment.appointmentId,
	]);
	expect(result.fields.map((field) => field.name)).toEqual(["professional_id", "patient_id", "service_id"]);
	expect(result.rows).toEqual([
		{
			professional_id: appointment.professionalId,
			patient_id: appointment.patientId,
			service_id: appointment.serviceId,
		},
	]);
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

it("uses the dedicated metadata owner and a trusted search path for all metadata functions", async () => {
	const names = functionCalls.map(([name]) => name);
	const { rows } = await setup.query(
		`
        SELECT proname, pg_catalog.pg_get_userbyid(proowner) AS owner, prosecdef, proconfig
        FROM pg_catalog.pg_proc
        WHERE pronamespace = 'public'::regnamespace AND proname = ANY($1::text[]) ORDER BY proname
    `,
		[names],
	);
	expect(rows).toEqual(
		[...names]
			.sort()
			.map((proname) => ({
				proname,
				owner: "medical_data_hub_metadata_owner",
				prosecdef: true,
				proconfig: ["search_path=pg_catalog, pg_temp"],
			})),
	);
});

it("limits metadata owner SELECT privileges to the required identifier and relationship columns", async () => {
	const { rows } = await setup.query(`
        SELECT table_definition.relname, column_definition.attname
        FROM pg_catalog.pg_class AS table_definition
        JOIN pg_catalog.pg_namespace AS schema_definition ON schema_definition.oid = table_definition.relnamespace
        JOIN pg_catalog.pg_attribute AS column_definition ON column_definition.attrelid = table_definition.oid
        WHERE schema_definition.nspname = 'public' AND table_definition.relkind = 'r'
          AND column_definition.attnum > 0 AND NOT column_definition.attisdropped
          AND pg_catalog.has_column_privilege('medical_data_hub_metadata_owner', table_definition.oid,
                                             column_definition.attnum, 'SELECT')
        ORDER BY table_definition.relname, column_definition.attname
    `);
	expect(rows).toEqual([
		{ relname: "appointments", attname: "appointment_id" },
		{ relname: "appointments", attname: "clinic_id" },
		{ relname: "appointments", attname: "patient_id" },
		{ relname: "appointments", attname: "professional_id" },
		{ relname: "appointments", attname: "service_id" },
		{ relname: "professionals", attname: "clinic_id" },
		{ relname: "professionals", attname: "professional_id" },
		{ relname: "professionals", attname: "user_id" },
		{ relname: "users", attname: "clinic_id" },
		{ relname: "users", attname: "user_id" },
	]);
});

it("denies metadata execution to the reception profile", async () => {
	for (const [name, query] of functionCalls) {
		await api.query("BEGIN");
		try {
			await api.query("SET LOCAL ROLE reception");
			await expect(api.query(query), name).rejects.toMatchObject({ code: "42501" });
		} finally {
			await api.query("ROLLBACK");
		}
	}
});
