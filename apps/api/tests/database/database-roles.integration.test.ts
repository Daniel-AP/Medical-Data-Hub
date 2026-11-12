import { randomUUID } from "node:crypto";
import { Client, escapeIdentifier } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

const setupConnectionString = process.env.DATABASE_SETUP_URL;
const apiConnectionString = process.env.DATABASE_URL;
if(!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const api = new Client({ connectionString: apiConnectionString });
const profileNames = ["platform_administrator", "clinic_administrator", "reception", "healthcare_professional"];
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
