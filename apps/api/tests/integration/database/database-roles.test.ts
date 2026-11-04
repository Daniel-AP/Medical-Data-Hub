import { randomUUID } from "node:crypto";
import { Client, escapeIdentifier } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

const setupConnectionString = process.env.DATABASE_SETUP_URL;
const apiConnectionString = process.env.DATABASE_URL;
if (!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const api = new Client({ connectionString: apiConnectionString });
const profileNames = ["platform_administrator", "clinic_administrator", "reception", "healthcare_professional"];
const domainTables = [
	"clinics",
	"clinic_availability_versions",
	"users",
	"specialties",
	"professionals",
	"services",
	"professional_services",
	"professional_schedules",
	"professional_blocks",
	"patients",
	"appointments",
	"clinical_notes",
	"audit_records",
];
const probeTable = escapeIdentifier(`database_roles_${randomUUID().replaceAll("-", "")}`);

beforeAll(async () => {
	await setup.connect();
	await api.connect();
	await setup.query(`CREATE TABLE public.${probeTable} (marker integer NOT NULL)`);
	await setup.query(`INSERT INTO public.${probeTable} (marker) VALUES (1)`);
	await setup.query(`GRANT SELECT ON public.${probeTable} TO clinic_administrator`);
});

afterAll(async () => {
	await setup.query(`DROP TABLE IF EXISTS public.${probeTable}`);
	await api.end();
	await setup.end();
});

it("connects with a restricted API login", async () => {
	const { rows } = await api.query(`
        SELECT rolname, rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
        FROM pg_catalog.pg_roles WHERE rolname = current_user
    `);
	expect(rows).toEqual([
		{
			rolname: "medical_data_hub_api",
			rolcanlogin: true,
			rolinherit: false,
			rolsuper: false,
			rolcreatedb: false,
			rolcreaterole: false,
			rolreplication: false,
			rolbypassrls: false,
		},
	]);
});

it("creates four profiles without login or administrative privileges", async () => {
	const { rows } = await setup.query(
		`
        SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
        FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname
    `,
		[profileNames],
	);
	expect(rows).toEqual(
		[...profileNames]
			.sort()
			.map((rolname) => ({
				rolname,
				rolcanlogin: false,
				rolsuper: false,
				rolcreatedb: false,
				rolcreaterole: false,
				rolreplication: false,
				rolbypassrls: false,
			})),
	);
});

it("permits profile selection without inheritance or membership administration", async () => {
	const { rows } = await setup.query(`
        SELECT profile.rolname, membership.inherit_option, membership.set_option, membership.admin_option
        FROM pg_catalog.pg_auth_members AS membership
        JOIN pg_catalog.pg_roles AS profile ON profile.oid = membership.roleid
        JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
        WHERE member.rolname = 'medical_data_hub_api' ORDER BY profile.rolname
    `);
	expect(rows).toEqual(
		[...profileNames]
			.sort()
			.map((rolname) => ({ rolname, inherit_option: false, set_option: true, admin_option: false })),
	);
});

it.each(profileNames)("selects the %s profile within a transaction", async (profileName) => {
	await api.query("BEGIN");
	try {
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		const { rows } = await api.query("SELECT current_user AS role");
		expect(rows).toEqual([{ role: profileName }]);
	} finally {
		await api.query("ROLLBACK");
	}
});

it.each(domainTables)("denies direct API reads on %s", async (tableName) => {
	await expect(api.query(`SELECT * FROM public.${escapeIdentifier(tableName)} LIMIT 1`)).rejects.toMatchObject({
		code: "42501",
	});
});

it("requires explicit profile selection to use a granted privilege", async () => {
	await expect(api.query(`SELECT marker FROM public.${probeTable}`)).rejects.toMatchObject({ code: "42501" });
	await api.query("BEGIN");
	try {
		await api.query("SET LOCAL ROLE clinic_administrator");
		const { rows } = await api.query(`SELECT marker FROM public.${probeTable}`);
		expect(rows).toEqual([{ marker: 1 }]);
	} finally {
		await api.query("ROLLBACK");
	}
	await expect(api.query(`SELECT marker FROM public.${probeTable}`)).rejects.toMatchObject({ code: "42501" });
});

it("denies selection of the setup role", async () => {
	const { rows } = await setup.query("SELECT current_user AS role");
	await expect(api.query(`SET ROLE ${escapeIdentifier(rows[0].role)}`)).rejects.toMatchObject({ code: "42501" });
});

it("denies direct API inserts into domain tables", async () => {
	await expect(
		api.query("INSERT INTO public.clinics (name, time_zone) VALUES ($1, $2)", [
			"Permission check",
			"America/Costa_Rica",
		]),
	).rejects.toMatchObject({ code: "42501" });
});

it("keeps the API login and profiles from owning domain tables", async () => {
	const { rows } = await setup.query(
		`
        SELECT table_definition.relname
        FROM pg_catalog.pg_class AS table_definition
        JOIN pg_catalog.pg_namespace AS schema_definition ON schema_definition.oid = table_definition.relnamespace
        JOIN pg_catalog.pg_roles AS owner ON owner.oid = table_definition.relowner
        WHERE schema_definition.nspname = 'public' AND table_definition.relname = ANY($1::text[])
          AND owner.rolname = ANY($2::text[])
    `,
		[domainTables, ["medical_data_hub_api", ...profileNames]],
	);
	expect(rows).toEqual([]);
});
