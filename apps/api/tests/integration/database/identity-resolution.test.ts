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
});

afterAll(async () => {
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

it("denies identity resolution to the platform_administrator profile", async () => {
	const profileName = "platform_administrator";
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

it("uses a dedicated function owner and a trusted search path", async () => {
	const { rows } = await setup.query(`
        SELECT pg_catalog.pg_get_userbyid(proowner) AS owner, prosecdef, proconfig
        FROM pg_catalog.pg_proc WHERE oid = 'public.resolve_identity(text)'::regprocedure
    `);
	expect(rows).toEqual([
		{ owner: "medical_data_hub_identity_owner", prosecdef: true, proconfig: ["search_path=pg_catalog, pg_temp"] },
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
