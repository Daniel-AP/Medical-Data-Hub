import { randomUUID } from "node:crypto";
import { Client, escapeIdentifier } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { Clinic, User } from "../../../src/generated/prisma/client.js";

type SeedUser = Pick<User, "userId" | "clinicId" | "identityId"> & { role: string };
type CreationResult = Pick<Clinic, "clinicId"> & Pick<User, "userId">;

const setupConnectionString = process.env.DATABASE_SETUP_URL;
const apiConnectionString = process.env.DATABASE_URL;
if (!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const api = new Client({ connectionString: apiConnectionString });
const ownerRole = "medical_data_hub_clinic_creation_owner";
const restrictedRoles = ["medical_data_hub_api", "clinic_administrator", "reception", "healthcare_professional"];
const applicationRoles = [...restrictedRoles, "platform_administrator"];
const createQuery = `SELECT clinic_id AS "clinicId", user_id AS "userId"
    FROM public.create_clinic($1::text, $2::text, $3::text)`;
const countsQuery = `SELECT
    (SELECT count(*) FROM public.clinics) AS clinics,
    (SELECT count(*) FROM public.users) AS users,
    (SELECT count(*) FROM public.clinic_availability_versions) AS versions`;
const setCreationContext = `SELECT pg_catalog.set_config('app.new_clinic_id', $1, true),
    pg_catalog.set_config('app.new_clinic_administrator_id', $2, true)`;
let platformActor: SeedUser;
let existingAdministrator: SeedUser;
let otherAdministrator: SeedUser;

beforeAll(async () => {
	await setup.connect();
	await api.connect();
	const { rows } = await setup.query<SeedUser>(`
        SELECT user_id AS "userId", clinic_id AS "clinicId", identity_id AS "identityId", role::text
        FROM public.users
        WHERE role IN ('platform_administrator', 'clinic_administrator')
        ORDER BY clinic_id
    `);
	platformActor = rows.find((user) => user.role === "platform_administrator")!;
	[existingAdministrator, otherAdministrator] = rows.filter((user) => user.role === "clinic_administrator");
});

beforeEach(async () => {
	await api.query("BEGIN");
	await setup.query("BEGIN");
});

afterEach(async () => {
	await api.query("ROLLBACK");
	await setup.query("ROLLBACK");
});

afterAll(async () => {
	await api.end();
	await setup.end();
});

it("creates a clinic, its active administrator, and its zero availability version in the caller transaction", async () => {
	const priorCounts = (await setup.query(countsQuery)).rows;
	const requestedName = "Synthetic clinic";
	const timeZone = "America/Costa_Rica";

	// Free a seeded realm identity inside the same rolled-back transaction.
	await setup.query("UPDATE public.users SET identity_id = $1 WHERE user_id = $2::uuid", [
		randomUUID(),
		existingAdministrator.userId,
	]);
	await setup.query("SET LOCAL SESSION AUTHORIZATION medical_data_hub_api");
	await setup.query("SET LOCAL ROLE platform_administrator");
	await setup.query(
		"SELECT pg_catalog.set_config('app.user_id', $1, true), pg_catalog.set_config('app.clinic_id', '', true)",
		[platformActor.userId],
	);
	await setup.query(setCreationContext, [existingAdministrator.clinicId, existingAdministrator.userId]);

	const created = await setup.query<CreationResult>(createQuery, [
		requestedName,
		timeZone,
		existingAdministrator.identityId,
	]);
	expect(created.rows).toEqual([{ clinicId: expect.any(String), userId: expect.any(String) }]);
	const { clinicId, userId } = created.rows[0];
	expect(clinicId).not.toBe(existingAdministrator.clinicId);
	expect(userId).not.toBe(existingAdministrator.userId);
	const context = await setup.query(`
        SELECT current_user AS role,
            pg_catalog.current_setting('app.user_id', true) AS actor,
            pg_catalog.current_setting('app.clinic_id', true) AS clinic,
            pg_catalog.current_setting('app.new_clinic_id', true) AS "priorClinic",
            pg_catalog.current_setting('app.new_clinic_administrator_id', true) AS "priorAdministrator"
    `);
	expect(context.rows).toEqual([
		{
			role: "platform_administrator",
			actor: platformActor.userId,
			clinic: "",
			priorClinic: existingAdministrator.clinicId,
			priorAdministrator: existingAdministrator.userId,
		},
	]);

	await setup.query("SET LOCAL SESSION AUTHORIZATION DEFAULT");
	const { rows } = await setup.query(
		`SELECT clinic.name, clinic.time_zone, administrator.identity_id, administrator.role::text,
            administrator.is_active, availability.version
        FROM public.clinics AS clinic
        JOIN public.users AS administrator USING (clinic_id)
        JOIN public.clinic_availability_versions AS availability USING (clinic_id)
        WHERE clinic.clinic_id = $1::uuid AND administrator.user_id = $2::uuid`,
		[clinicId, userId],
	);
	expect(rows).toEqual([
		{
			name: requestedName,
			time_zone: timeZone,
			identity_id: existingAdministrator.identityId,
			role: "clinic_administrator",
			is_active: true,
			version: "0",
		},
	]);

	await setup.query("ROLLBACK");
	expect((await setup.query(countsQuery)).rows).toEqual(priorCounts);
	expect(
		(
			await setup.query("SELECT user_id FROM public.users WHERE identity_id = $1", [
				existingAdministrator.identityId,
			])
		).rows,
	).toEqual([{ user_id: existingAdministrator.userId }]);
});

it("rejects a duplicate administrator identity without leaving a partial clinic", async () => {
	const priorCounts = (await setup.query(countsQuery)).rows;
	await api.query("SET LOCAL ROLE platform_administrator");
	await expect(
		api.query(createQuery, ["Duplicate identity clinic", "UTC", existingAdministrator.identityId]),
	).rejects.toMatchObject({ code: "23505", constraint: "users_identity_id_key" });
	await api.query("ROLLBACK");

	expect((await setup.query(countsQuery)).rows).toEqual(priorCounts);
	expect(
		(
			await setup.query("SELECT clinic_id FROM public.users WHERE identity_id = $1", [
				existingAdministrator.identityId,
			])
		).rows,
	).toEqual([{ clinic_id: existingAdministrator.clinicId }]);
});

it("denies clinic creation execution to medical_data_hub_api", async () => {
	const roleName = "medical_data_hub_api";
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(roleName)}`);
	await expect(
		api.query(createQuery, ["Synthetic clinic", "UTC", existingAdministrator.identityId]),
	).rejects.toMatchObject({ code: "42501", message: "permission denied for function create_clinic" });
});

it("keeps the API login and its operating roles outside clinic creation owner membership", async () => {
	const { rows } = await setup.query(
		`SELECT role_name FROM unnest($1::text[]) AS role_name
        WHERE pg_catalog.pg_has_role(role_name, $2, 'MEMBER')`,
		[applicationRoles, ownerRole],
	);
	expect(rows).toEqual([]);
	await expect(api.query("SET LOCAL ROLE medical_data_hub_clinic_creation_owner")).rejects.toMatchObject({
		code: "42501",
	});
});

it("uses a restricted clinic creation owner and grants function execution only to platform", async () => {
	const { rows } = await setup.query(`
        SELECT owner.rolname, owner.rolcanlogin, owner.rolsuper, owner.rolbypassrls,
            owner.rolcreatedb, owner.rolcreaterole, owner.rolreplication, routine.prosecdef, routine.proconfig,
            ARRAY(SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee)::text END
                FROM pg_catalog.aclexplode(routine.proacl) AS acl
                WHERE acl.privilege_type = 'EXECUTE' AND acl.grantee <> routine.proowner) AS executors
        FROM pg_catalog.pg_proc AS routine
        JOIN pg_catalog.pg_roles AS owner ON owner.oid = routine.proowner
        WHERE routine.oid = 'public.create_clinic(text,text,text)'::regprocedure
    `);
	expect(rows).toEqual([
		{
			rolname: ownerRole,
			rolcanlogin: false,
			rolsuper: false,
			rolbypassrls: false,
			rolcreatedb: false,
			rolcreaterole: false,
			rolreplication: false,
			prosecdef: true,
			proconfig: ["search_path=pg_catalog, pg_temp", "app.new_clinic_id=", "app.new_clinic_administrator_id="],
			executors: ["platform_administrator"],
		},
	]);
});

it("denies direct platform insertion into clinics", async () => {
	await api.query("SET LOCAL ROLE platform_administrator");
	await expect(
		api.query("INSERT INTO public.clinics (name, time_zone) VALUES ('Synthetic clinic', 'UTC')"),
	).rejects.toMatchObject({ code: "42501" });
});

it("limits clinic creation owner reads to the scoped identifiers", async () => {
	await setup.query(setCreationContext, [existingAdministrator.clinicId, existingAdministrator.userId]);
	await setup.query("SET LOCAL ROLE medical_data_hub_clinic_creation_owner");
	expect((await setup.query("SELECT clinic_id FROM public.clinics")).rows).toEqual([
		{ clinic_id: existingAdministrator.clinicId },
	]);
	expect((await setup.query("SELECT user_id FROM public.users")).rows).toEqual([
		{ user_id: existingAdministrator.userId },
	]);
	await setup.query(setCreationContext, [existingAdministrator.clinicId, otherAdministrator.userId]);
	expect((await setup.query("SELECT user_id FROM public.users")).rows).toEqual([]);
});

it("grants the clinic creation owner only its required table columns", async () => {
	const { rows } = await setup.query(
		`SELECT table_name, column_name, privilege_type, is_grantable FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND grantee = $1 ORDER BY table_name, column_name, privilege_type`,
		[ownerRole],
	);
	expect(rows).toEqual([
		{
			table_name: "clinic_availability_versions",
			column_name: "clinic_id",
			privilege_type: "INSERT",
			is_grantable: "NO",
		},
		{ table_name: "clinics", column_name: "clinic_id", privilege_type: "INSERT", is_grantable: "NO" },
		{ table_name: "clinics", column_name: "clinic_id", privilege_type: "SELECT", is_grantable: "NO" },
		{ table_name: "clinics", column_name: "name", privilege_type: "INSERT", is_grantable: "NO" },
		{ table_name: "clinics", column_name: "time_zone", privilege_type: "INSERT", is_grantable: "NO" },
		{ table_name: "users", column_name: "clinic_id", privilege_type: "INSERT", is_grantable: "NO" },
		{ table_name: "users", column_name: "identity_id", privilege_type: "INSERT", is_grantable: "NO" },
		{ table_name: "users", column_name: "role", privilege_type: "INSERT", is_grantable: "NO" },
		{ table_name: "users", column_name: "user_id", privilege_type: "INSERT", is_grantable: "NO" },
		{ table_name: "users", column_name: "user_id", privilege_type: "SELECT", is_grantable: "NO" },
	]);
});
