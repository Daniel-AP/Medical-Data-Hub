import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

const setupConnectionString = process.env.DATABASE_SETUP_URL;
if(!setupConnectionString) {
	throw new Error("DATABASE_SETUP_URL is required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const ownerRole = "medical_data_hub_clinic_creation_owner";

beforeAll(async () => {
	await setup.connect();
});

afterAll(async () => {
	await setup.end();
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
