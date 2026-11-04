import { randomUUID } from "node:crypto";
import { Client, escapeIdentifier } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { User } from "../../../src/generated/prisma/client.js";

type LocalIdentity = Pick<User, "identityId" | "userId" | "clinicId">;

const setupConnectionString = process.env.DATABASE_SETUP_URL;
const apiConnectionString = process.env.DATABASE_URL;
if (!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const api = new Client({ connectionString: apiConnectionString });
const profileNames = ["platform_administrator", "clinic_administrator", "reception", "healthcare_professional"];
const outsiderRole = escapeIdentifier(`identity_test_${randomUUID().replaceAll("-", "")}`);
let reception: LocalIdentity;
let platform: LocalIdentity;

beforeAll(async () => {
	await setup.connect();
	await api.connect();
	const receptionResult = await setup.query<LocalIdentity>(`
        SELECT identity_id AS "identityId", user_id AS "userId", clinic_id AS "clinicId"
        FROM public.users WHERE role = 'reception' ORDER BY user_id LIMIT 1
    `);
	reception = receptionResult.rows[0];
	const platformResult = await setup.query<LocalIdentity>(`
        SELECT identity_id AS "identityId", user_id AS "userId", clinic_id AS "clinicId"
        FROM public.users WHERE role = 'platform_administrator' ORDER BY user_id LIMIT 1
    `);
	platform = platformResult.rows[0];
	await setup.query(`CREATE ROLE ${outsiderRole} NOLOGIN`);
});

afterAll(async () => {
	await setup.query(`DROP ROLE ${outsiderRole}`);
	await api.end();
	await setup.end();
});

it("resolves only the local user and clinic identifiers for a provider identity", async () => {
	const result = await api.query("SELECT * FROM public.resolve_identity($1::text)", [reception.identityId]);
	expect(result.fields.map((field) => field.name)).toEqual(["user_id", "clinic_id"]);
	expect(result.rows).toEqual([{ user_id: reception.userId, clinic_id: reception.clinicId }]);
});

it("resolves a platform identity with a NULL clinic", async () => {
	const { rows } = await api.query("SELECT * FROM public.resolve_identity($1::text)", [platform.identityId]);
	expect(rows).toEqual([{ user_id: platform.userId, clinic_id: null }]);
});

it("returns no association for an unknown provider identity", async () => {
	const { rows } = await api.query("SELECT * FROM public.resolve_identity($1::text)", [randomUUID()]);
	expect(rows).toEqual([]);
});

it("returns no association for an empty provider identity", async () => {
	const { rows } = await api.query("SELECT * FROM public.resolve_identity($1::text)", [""]);
	expect(rows).toEqual([]);
});

it("returns no association for a NULL provider identity", async () => {
	const { rows } = await api.query("SELECT * FROM public.resolve_identity($1::text)", [null]);
	expect(rows).toEqual([]);
});

it("treats SQL syntax in the provider identity as data", async () => {
	const { rows } = await api.query("SELECT * FROM public.resolve_identity($1::text)", ["' OR true --"]);
	expect(rows).toEqual([]);
});

it("resolves an inactive account without performing activity authorization", async () => {
	await setup.query("BEGIN");
	try {
		await setup.query("UPDATE public.users SET is_active = false WHERE user_id = $1::uuid", [reception.userId]);
		await setup.query("SET LOCAL ROLE medical_data_hub_api");
		const { rows } = await setup.query("SELECT * FROM public.resolve_identity($1::text)", [reception.identityId]);
		expect(rows).toEqual([{ user_id: reception.userId, clinic_id: reception.clinicId }]);
	} finally {
		await setup.query("ROLLBACK");
	}
});

it.each(profileNames)("denies identity resolution to the %s profile", async (profileName) => {
	await api.query("BEGIN");
	try {
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		await expect(
			api.query("SELECT * FROM public.resolve_identity($1::text)", [reception.identityId]),
		).rejects.toMatchObject({ code: "42501" });
	} finally {
		await api.query("ROLLBACK");
	}
});

it("denies identity resolution through PUBLIC privileges", async () => {
	await setup.query("BEGIN");
	try {
		await setup.query(`SET LOCAL ROLE ${outsiderRole}`);
		await expect(
			setup.query("SELECT * FROM public.resolve_identity($1::text)", [reception.identityId]),
		).rejects.toMatchObject({ code: "42501" });
	} finally {
		await setup.query("ROLLBACK");
	}
});

it("uses a dedicated function owner and a trusted search path", async () => {
	const { rows } = await setup.query(`
        SELECT pg_catalog.pg_get_userbyid(proowner) AS owner, prosecdef, proconfig
        FROM pg_catalog.pg_proc WHERE oid = 'public.resolve_identity(text)'::regprocedure
    `);
	expect(rows).toEqual([
		{ owner: "medical_data_hub_identity_owner", prosecdef: true, proconfig: ["search_path=pg_catalog, pg_temp"] },
	]);
});

it("keeps the identity owner without login or administrative privileges", async () => {
	const { rows } = await setup.query(`
        SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
        FROM pg_catalog.pg_roles WHERE rolname = 'medical_data_hub_identity_owner'
    `);
	expect(rows).toEqual([
		{
			rolcanlogin: false,
			rolsuper: false,
			rolcreatedb: false,
			rolcreaterole: false,
			rolreplication: false,
			rolbypassrls: false,
		},
	]);
});

it("keeps application roles outside identity owner membership", async () => {
	const { rows } = await setup.query(
		`
        SELECT rolname, pg_catalog.pg_has_role(rolname, 'medical_data_hub_identity_owner', 'MEMBER') AS member
        FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname
    `,
		[["medical_data_hub_api", ...profileNames]],
	);
	expect(rows).toEqual(
		["medical_data_hub_api", ...profileNames].sort().map((rolname) => ({ rolname, member: false })),
	);
});

it("denies selection of the identity owner by the API login", async () => {
	await expect(api.query("SET ROLE medical_data_hub_identity_owner")).rejects.toMatchObject({ code: "42501" });
});

it("allows the identity owner to read only its required user metadata", async () => {
	await setup.query("BEGIN");
	try {
		await setup.query("SET LOCAL ROLE medical_data_hub_identity_owner");
		const { rows } = await setup.query(
			`
            SELECT identity_id, user_id, clinic_id FROM public.users WHERE user_id = $1::uuid
        `,
			[reception.userId],
		);
		expect(rows).toEqual([
			{ identity_id: reception.identityId, user_id: reception.userId, clinic_id: reception.clinicId },
		]);
	} finally {
		await setup.query("ROLLBACK");
	}
});

it.each(["role", "is_active"])("denies identity owner reads of users.%s", async (columnName) => {
	await setup.query("BEGIN");
	try {
		await setup.query("SET LOCAL ROLE medical_data_hub_identity_owner");
		await expect(
			setup.query(`SELECT ${escapeIdentifier(columnName)} FROM public.users LIMIT 1`),
		).rejects.toMatchObject({ code: "42501" });
	} finally {
		await setup.query("ROLLBACK");
	}
});

it.each(["patients", "clinical_notes"])("denies identity owner reads of %s", async (tableName) => {
	await setup.query("BEGIN");
	try {
		await setup.query("SET LOCAL ROLE medical_data_hub_identity_owner");
		await expect(setup.query(`SELECT * FROM public.${escapeIdentifier(tableName)} LIMIT 1`)).rejects.toMatchObject({
			code: "42501",
		});
	} finally {
		await setup.query("ROLLBACK");
	}
});

it("denies user updates by the identity owner", async () => {
	await setup.query("BEGIN");
	try {
		await setup.query("SET LOCAL ROLE medical_data_hub_identity_owner");
		await expect(
			setup.query("UPDATE public.users SET is_active = false WHERE user_id = $1::uuid", [reception.userId]),
		).rejects.toMatchObject({ code: "42501" });
	} finally {
		await setup.query("ROLLBACK");
	}
});

it("keeps ordinary user-table reads denied after identity resolution", async () => {
	await api.query("SELECT * FROM public.resolve_identity($1::text)", [reception.identityId]);
	const { rows } = await api.query("SELECT current_user AS role");
	expect(rows).toEqual([{ role: "medical_data_hub_api" }]);
	await expect(api.query("SELECT user_id, clinic_id FROM public.users")).rejects.toMatchObject({ code: "42501" });
});

it("prevents application roles from creating objects in the function schema", async () => {
	const { rows } = await setup.query(
		`
        SELECT rolname, pg_catalog.has_schema_privilege(rolname, 'public', 'CREATE') AS can_create
        FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname
    `,
		[["medical_data_hub_api", "medical_data_hub_identity_owner", ...profileNames]],
	);
	expect(rows).toEqual(
		["medical_data_hub_api", "medical_data_hub_identity_owner", ...profileNames]
			.sort()
			.map((rolname) => ({ rolname, can_create: false })),
	);
});

it("ignores a caller temporary table and search path during identity resolution", async () => {
	await api.query("BEGIN");
	try {
		await api.query("CREATE TEMP TABLE users (identity_id text, user_id uuid, clinic_id uuid) ON COMMIT DROP");
		await api.query("INSERT INTO pg_temp.users (identity_id, user_id, clinic_id) VALUES ($1, $2::uuid, $3::uuid)", [
			reception.identityId,
			randomUUID(),
			randomUUID(),
		]);
		await api.query("GRANT SELECT ON pg_temp.users TO medical_data_hub_identity_owner");
		await api.query("SET LOCAL search_path = pg_temp, public");
		const { rows } = await api.query("SELECT * FROM public.resolve_identity($1::text)", [reception.identityId]);
		expect(rows).toEqual([{ user_id: reception.userId, clinic_id: reception.clinicId }]);
	} finally {
		await api.query("ROLLBACK");
	}
});
