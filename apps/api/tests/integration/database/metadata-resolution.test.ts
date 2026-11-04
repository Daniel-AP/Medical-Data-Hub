import { randomUUID } from "node:crypto";
import { Client, escapeIdentifier } from "pg";
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
const profileNames = ["platform_administrator", "clinic_administrator", "reception", "healthcare_professional"];
const functionCalls = [
	["resolve_actor_professional", "SELECT * FROM public.resolve_actor_professional(NULL::uuid)"],
	["resolve_professional_user", "SELECT * FROM public.resolve_professional_user(NULL::uuid, NULL::uuid)"],
	["resolve_appointment_references", "SELECT * FROM public.resolve_appointment_references(NULL::uuid, NULL::uuid)"],
] as const;
const outsiderRole = escapeIdentifier(`metadata_test_${randomUUID().replaceAll("-", "")}`);
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
	await setup.query(`CREATE ROLE ${outsiderRole} NOLOGIN`);
});

afterAll(async () => {
	await setup.query(`DROP ROLE ${outsiderRole}`);
	await api.end();
	await setup.end();
});

it("resolves only the actor's own professional identifier", async () => {
	const result = await api.query("SELECT * FROM public.resolve_actor_professional($1::uuid)", [professional.userId]);
	expect(result.fields.map((field) => field.name)).toEqual(["professional_id"]);
	expect(result.rows).toEqual([{ professional_id: professional.professionalId }]);
});

it("returns no professional profile for an actor without one", async () => {
	const { rows } = await api.query("SELECT * FROM public.resolve_actor_professional($1::uuid)", [actor.userId]);
	expect(rows).toEqual([]);
});

it("returns no professional profile for a missing or NULL actor", async () => {
	for (const actorId of [randomUUID(), null]) {
		const { rows } = await api.query("SELECT * FROM public.resolve_actor_professional($1::uuid)", [actorId]);
		expect(rows).toEqual([]);
	}
});

it("returns no professional profile for a platform actor", async () => {
	const { rows } = await api.query("SELECT * FROM public.resolve_actor_professional($1::uuid)", [platform.userId]);
	expect(rows).toEqual([]);
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

it("returns no professional user for a missing or NULL professional", async () => {
	for (const professionalId of [randomUUID(), null]) {
		const { rows } = await api.query("SELECT * FROM public.resolve_professional_user($1::uuid, $2::uuid)", [
			actor.userId,
			professionalId,
		]);
		expect(rows).toEqual([]);
	}
});

it("returns no professional user for a missing or NULL actor", async () => {
	for (const actorId of [randomUUID(), null]) {
		const { rows } = await api.query("SELECT * FROM public.resolve_professional_user($1::uuid, $2::uuid)", [
			actorId,
			professional.professionalId,
		]);
		expect(rows).toEqual([]);
	}
});

it("gives no professional metadata to a platform actor with a NULL clinic", async () => {
	const { rows } = await api.query("SELECT * FROM public.resolve_professional_user($1::uuid, $2::uuid)", [
		platform.userId,
		professional.professionalId,
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

it("returns no appointment references for a missing or NULL appointment", async () => {
	for (const appointmentId of [randomUUID(), null]) {
		const { rows } = await api.query("SELECT * FROM public.resolve_appointment_references($1::uuid, $2::uuid)", [
			actor.userId,
			appointmentId,
		]);
		expect(rows).toEqual([]);
	}
});

it("returns no appointment references for a missing or NULL actor", async () => {
	for (const actorId of [randomUUID(), null]) {
		const { rows } = await api.query("SELECT * FROM public.resolve_appointment_references($1::uuid, $2::uuid)", [
			actorId,
			appointment.appointmentId,
		]);
		expect(rows).toEqual([]);
	}
});

it("gives no appointment metadata to a platform actor with a NULL clinic", async () => {
	const { rows } = await api.query("SELECT * FROM public.resolve_appointment_references($1::uuid, $2::uuid)", [
		platform.userId,
		appointment.appointmentId,
	]);
	expect(rows).toEqual([]);
});

it("derives another actor's metadata scope from that actor's clinic", async () => {
	const professionalResult = await api.query("SELECT * FROM public.resolve_professional_user($1::uuid, $2::uuid)", [
		otherActor.userId,
		otherProfessional.professionalId,
	]);
	expect(professionalResult.rows).toEqual([{ user_id: otherProfessional.userId }]);
	const appointmentResult = await api.query(
		"SELECT * FROM public.resolve_appointment_references($1::uuid, $2::uuid)",
		[otherActor.userId, otherAppointment.appointmentId],
	);
	expect(appointmentResult.rows).toEqual([
		{
			professional_id: otherAppointment.professionalId,
			patient_id: otherAppointment.patientId,
			service_id: otherAppointment.serviceId,
		},
	]);
});

it("leaves activity and role authorization to protected transaction preparation", async () => {
	await setup.query("BEGIN");
	try {
		await setup.query("UPDATE public.users SET is_active = false WHERE user_id = ANY($1::uuid[])", [
			[actor.userId, professional.userId],
		]);
		await setup.query("UPDATE public.users SET role = 'reception' WHERE user_id = $1::uuid", [professional.userId]);
		await setup.query("SET LOCAL ROLE medical_data_hub_api");
		const profile = await setup.query("SELECT * FROM public.resolve_actor_professional($1::uuid)", [
			professional.userId,
		]);
		expect(profile.rows).toEqual([{ professional_id: professional.professionalId }]);
		const user = await setup.query("SELECT * FROM public.resolve_professional_user($1::uuid, $2::uuid)", [
			actor.userId,
			professional.professionalId,
		]);
		expect(user.rows).toEqual([{ user_id: professional.userId }]);
		const references = await setup.query(
			"SELECT * FROM public.resolve_appointment_references($1::uuid, $2::uuid)",
			[actor.userId, appointment.appointmentId],
		);
		expect(references.rows).toEqual([
			{
				professional_id: appointment.professionalId,
				patient_id: appointment.patientId,
				service_id: appointment.serviceId,
			},
		]);
	} finally {
		await setup.query("ROLLBACK");
	}
});

it("does not acquire user, professional, or appointment row locks during metadata preparation", async () => {
	await api.query("BEGIN");
	await setup.query("BEGIN");
	try {
		await api.query("SELECT * FROM public.resolve_actor_professional($1::uuid)", [professional.userId]);
		await api.query("SELECT * FROM public.resolve_professional_user($1::uuid, $2::uuid)", [
			actor.userId,
			professional.professionalId,
		]);
		await api.query("SELECT * FROM public.resolve_appointment_references($1::uuid, $2::uuid)", [
			actor.userId,
			appointment.appointmentId,
		]);
		await setup.query("SET LOCAL lock_timeout = '500ms'");
		await setup.query("SELECT user_id FROM public.users WHERE user_id = ANY($1::uuid[]) FOR UPDATE", [
			[actor.userId, professional.userId],
		]);
		await setup.query(
			"SELECT professional_id FROM public.professionals WHERE professional_id = $1::uuid FOR UPDATE",
			[professional.professionalId],
		);
		await setup.query("SELECT appointment_id FROM public.appointments WHERE appointment_id = $1::uuid FOR UPDATE", [
			appointment.appointmentId,
		]);
	} finally {
		await setup.query("ROLLBACK");
		await api.query("ROLLBACK");
	}
});

it.each(profileNames)("denies metadata execution to the %s profile", async (profileName) => {
	for (const [name, query] of functionCalls) {
		await api.query("BEGIN");
		try {
			await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
			await expect(api.query(query), name).rejects.toMatchObject({ code: "42501" });
		} finally {
			await api.query("ROLLBACK");
		}
	}
});

it.each(functionCalls)("denies %s execution through PUBLIC privileges", async (_name, query) => {
	await setup.query("BEGIN");
	try {
		await setup.query(`SET LOCAL ROLE ${outsiderRole}`);
		await expect(setup.query(query)).rejects.toMatchObject({ code: "42501" });
	} finally {
		await setup.query("ROLLBACK");
	}
});

it.each(functionCalls)("denies %s execution to the identity owner", async (_name, query) => {
	await setup.query("BEGIN");
	try {
		await setup.query("SET LOCAL ROLE medical_data_hub_identity_owner");
		await expect(setup.query(query)).rejects.toMatchObject({ code: "42501" });
	} finally {
		await setup.query("ROLLBACK");
	}
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

it("keeps the metadata owner without login, administrative, or schema creation privileges", async () => {
	const { rows } = await setup.query(`
        SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls,
               pg_catalog.has_schema_privilege(rolname, 'public', 'CREATE') AS can_create
        FROM pg_catalog.pg_roles WHERE rolname = 'medical_data_hub_metadata_owner'
    `);
	expect(rows).toEqual([
		{
			rolcanlogin: false,
			rolsuper: false,
			rolcreatedb: false,
			rolcreaterole: false,
			rolreplication: false,
			rolbypassrls: false,
			can_create: false,
		},
	]);
});

it("keeps application roles and the identity owner outside metadata owner membership", async () => {
	const names = ["medical_data_hub_api", "medical_data_hub_identity_owner", ...profileNames];
	const { rows } = await setup.query(
		`
        SELECT rolname, pg_catalog.pg_has_role(rolname, 'medical_data_hub_metadata_owner', 'MEMBER') AS member
        FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname
    `,
		[names],
	);
	expect(rows).toEqual([...names].sort().map((rolname) => ({ rolname, member: false })));
});

it("denies selection of the metadata owner by the API login", async () => {
	await expect(api.query("SET ROLE medical_data_hub_metadata_owner")).rejects.toMatchObject({ code: "42501" });
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

it.each([
	["users.identity_id", "SELECT identity_id FROM public.users LIMIT 1"],
	["users.role", "SELECT role FROM public.users LIMIT 1"],
	["users.is_active", "SELECT is_active FROM public.users LIMIT 1"],
	["professionals.specialty_id", "SELECT specialty_id FROM public.professionals LIMIT 1"],
	["appointments.state", "SELECT state FROM public.appointments LIMIT 1"],
	["patients contact", "SELECT email, phone FROM public.patients LIMIT 1"],
	["clinical note content", "SELECT content FROM public.clinical_notes LIMIT 1"],
])("denies metadata owner reads of %s", async (_name, query) => {
	await setup.query("BEGIN");
	try {
		await setup.query("SET LOCAL ROLE medical_data_hub_metadata_owner");
		await expect(setup.query(query)).rejects.toMatchObject({ code: "42501" });
	} finally {
		await setup.query("ROLLBACK");
	}
});

it.each(["users", "professionals", "appointments"])("denies metadata owner updates to %s", async (tableName) => {
	await setup.query("BEGIN");
	try {
		await setup.query("SET LOCAL ROLE medical_data_hub_metadata_owner");
		await expect(
			setup.query(`UPDATE public.${escapeIdentifier(tableName)} SET clinic_id = clinic_id WHERE false`),
		).rejects.toMatchObject({ code: "42501" });
	} finally {
		await setup.query("ROLLBACK");
	}
});

it("denies preliminary identity resolution to the metadata owner", async () => {
	await setup.query("BEGIN");
	try {
		await setup.query("SET LOCAL ROLE medical_data_hub_metadata_owner");
		await expect(setup.query("SELECT * FROM public.resolve_identity(NULL::text)")).rejects.toMatchObject({
			code: "42501",
		});
	} finally {
		await setup.query("ROLLBACK");
	}
});

it("keeps caller role and direct domain-table permissions unchanged after metadata resolution", async () => {
	await api.query("SELECT * FROM public.resolve_actor_professional($1::uuid)", [professional.userId]);
	await api.query("SELECT * FROM public.resolve_professional_user($1::uuid, $2::uuid)", [
		actor.userId,
		professional.professionalId,
	]);
	await api.query("SELECT * FROM public.resolve_appointment_references($1::uuid, $2::uuid)", [
		actor.userId,
		appointment.appointmentId,
	]);
	const { rows } = await api.query("SELECT current_user AS role");
	expect(rows).toEqual([{ role: "medical_data_hub_api" }]);
	for (const tableName of ["users", "professionals", "appointments"]) {
		await expect(api.query(`SELECT clinic_id FROM public.${escapeIdentifier(tableName)}`)).rejects.toMatchObject({
			code: "42501",
		});
	}
});

it("ignores caller temporary tables and search path for all metadata lookups", async () => {
	await api.query("BEGIN");
	try {
		await api.query("CREATE TEMP TABLE users (user_id uuid, clinic_id uuid) ON COMMIT DROP");
		await api.query(
			"CREATE TEMP TABLE professionals (professional_id uuid, clinic_id uuid, user_id uuid) ON COMMIT DROP",
		);
		await api.query(`CREATE TEMP TABLE appointments (
            appointment_id uuid, clinic_id uuid, professional_id uuid, patient_id uuid, service_id uuid
        ) ON COMMIT DROP`);
		const fakeProfessionalId = randomUUID();
		await api.query(
			"INSERT INTO pg_temp.users (user_id, clinic_id) VALUES ($1::uuid, $2::uuid), ($3::uuid, $2::uuid)",
			[actor.userId, actor.clinicId, professional.userId],
		);
		await api.query(
			`INSERT INTO pg_temp.professionals (professional_id, clinic_id, user_id)
            VALUES ($1::uuid, $2::uuid, $3::uuid), ($4::uuid, $2::uuid, $5::uuid)`,
			[professional.professionalId, actor.clinicId, randomUUID(), fakeProfessionalId, professional.userId],
		);
		await api.query(
			`INSERT INTO pg_temp.appointments (appointment_id, clinic_id, professional_id, patient_id, service_id)
            VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid)`,
			[appointment.appointmentId, actor.clinicId, fakeProfessionalId, randomUUID(), randomUUID()],
		);
		await api.query(
			"GRANT SELECT ON pg_temp.users, pg_temp.professionals, pg_temp.appointments TO medical_data_hub_metadata_owner",
		);
		await api.query("SET LOCAL search_path = pg_temp, public");

		const profile = await api.query("SELECT * FROM public.resolve_actor_professional($1::uuid)", [
			professional.userId,
		]);
		expect(profile.rows).toEqual([{ professional_id: professional.professionalId }]);
		const user = await api.query("SELECT * FROM public.resolve_professional_user($1::uuid, $2::uuid)", [
			actor.userId,
			professional.professionalId,
		]);
		expect(user.rows).toEqual([{ user_id: professional.userId }]);
		const references = await api.query("SELECT * FROM public.resolve_appointment_references($1::uuid, $2::uuid)", [
			actor.userId,
			appointment.appointmentId,
		]);
		expect(references.rows).toEqual([
			{
				professional_id: appointment.professionalId,
				patient_id: appointment.patientId,
				service_id: appointment.serviceId,
			},
		]);
	} finally {
		await api.query("ROLLBACK");
	}
});
