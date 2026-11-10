import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { User } from "../../../src/generated/prisma/client.js";

type LocalUser = Pick<User, "userId" | "clinicId" | "isActive"> & { role: string };

const setupConnectionString = process.env.DATABASE_SETUP_URL;
const apiConnectionString = process.env.DATABASE_URL;
if(!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const api = new Client({ connectionString: apiConnectionString });
const contender = new Client({ connectionString: apiConnectionString });
const lockFunctions = [
	["lock_user_for_share", "SELECT * FROM public.lock_user_for_share($1::uuid, $2::uuid)"],
	["lock_user_for_no_key_update", "SELECT * FROM public.lock_user_for_no_key_update($1::uuid, $2::uuid)"],
] as const;
let actor: LocalUser;
let target: LocalUser;
let otherActor: LocalUser;
let platform: LocalUser;

beforeAll(async () => {

	await setup.connect();
	await api.connect();
	await contender.connect();
	const actors = await setup.query<LocalUser>(`
        SELECT user_id AS "userId", clinic_id AS "clinicId", role::text, is_active AS "isActive"
        FROM public.users WHERE role = 'reception' ORDER BY clinic_id, user_id
    `);
	[actor, otherActor] = actors.rows;
	const targetResult = await setup.query<LocalUser>(
		`
        SELECT user_id AS "userId", clinic_id AS "clinicId", role::text, is_active AS "isActive"
        FROM public.users WHERE clinic_id = $1::uuid AND role = 'healthcare_professional' ORDER BY user_id LIMIT 1
    `,
		[actor.clinicId],
	);
	target = targetResult.rows[0];
	const platformResult = await setup.query<LocalUser>(`
        SELECT user_id AS "userId", clinic_id AS "clinicId", role::text, is_active AS "isActive"
        FROM public.users WHERE role = 'platform_administrator' ORDER BY user_id LIMIT 1
    `);
	platform = platformResult.rows[0];

});

afterAll(async () => {
	await contender.end();
	await api.end();
	await setup.end();
});

it.each(lockFunctions)(
	"returns only protected user identifiers, role, and activity through %s",
	async (_name, query) => {

		await api.query("BEGIN");
		try {

			const result = await api.query(query, [actor.userId, target.userId]);
			expect(result.fields.map((field) => field.name)).toEqual(["user_id", "clinic_id", "role", "is_active"]);
			expect(result.rows).toEqual([
				{ user_id: target.userId, clinic_id: target.clinicId, role: target.role, is_active: target.isActive },
			]);

		} finally {
			await api.query("ROLLBACK");
		}

	},
);

it.each(lockFunctions.slice(0, 1))("filters another clinic's user through %s", async (_name, query) => {
	const { rows } = await api.query(query, [actor.userId, otherActor.userId]);
	expect(rows).toEqual([]);
});

it.each(lockFunctions.slice(0, 1))(
	"allows a platform actor to lock only its own NULL-clinic row through %s",
	async (_name, query) => {

		await api.query("BEGIN");
		try {

			const ownRow = await api.query(query, [platform.userId, platform.userId]);
			expect(ownRow.rows).toEqual([
				{ user_id: platform.userId, clinic_id: null, role: platform.role, is_active: platform.isActive },
			]);
			const clinicRow = await api.query(query, [platform.userId, target.userId]);
			expect(clinicRow.rows).toEqual([]);

		} finally {
			await api.query("ROLLBACK");
		}

	},
);

it("acquires FOR SHARE locks compatible with shared readers and conflicting with user updates", async () => {

	await api.query("BEGIN");
	await setup.query("BEGIN");
	try {

		await api.query("SELECT * FROM public.lock_user_for_share($1::uuid, $2::uuid)", [actor.userId, target.userId]);
		const compatible = await setup.query(
			"SELECT user_id FROM public.users WHERE user_id = $1::uuid FOR SHARE NOWAIT",
			[target.userId],
		);
		expect(compatible.rows).toEqual([{ user_id: target.userId }]);
		await expect(
			setup.query("SELECT user_id FROM public.users WHERE user_id = $1::uuid FOR NO KEY UPDATE NOWAIT", [
				target.userId,
			]),
		).rejects.toMatchObject({ code: "55P03" });

	} finally {
		await setup.query("ROLLBACK");
		await api.query("ROLLBACK");
	}

});

it("acquires FOR NO KEY UPDATE locks compatible with key readers and conflicting with shared readers", async () => {

	await api.query("BEGIN");
	await setup.query("BEGIN");
	try {

		await api.query("SELECT * FROM public.lock_user_for_no_key_update($1::uuid, $2::uuid)", [
			actor.userId,
			target.userId,
		]);
		const compatible = await setup.query(
			"SELECT user_id FROM public.users WHERE user_id = $1::uuid FOR KEY SHARE NOWAIT",
			[target.userId],
		);
		expect(compatible.rows).toEqual([{ user_id: target.userId }]);
		await expect(
			setup.query("SELECT user_id FROM public.users WHERE user_id = $1::uuid FOR SHARE NOWAIT", [target.userId]),
		).rejects.toMatchObject({ code: "55P03" });

	} finally {
		await setup.query("ROLLBACK");
		await api.query("ROLLBACK");
	}

});

it("rejects an actual activity update by the locking owner through RLS", async () => {

	await setup.query("BEGIN");
	try {

		await setup.query("SET LOCAL ROLE medical_data_hub_locking_owner");
		const visible = await setup.query("SELECT user_id FROM public.users WHERE user_id = $1::uuid", [target.userId]);
		expect(visible.rows).toEqual([{ user_id: target.userId }]);
		await expect(
			setup.query("UPDATE public.users SET is_active = false WHERE user_id = $1::uuid", [target.userId]),
		).rejects.toMatchObject({
			code: "42501",
			message: 'new row violates row-level security policy for table "users"',
		});

	} finally {
		await setup.query("ROLLBACK");
	}

});

it("limits locking owner SELECT and UPDATE grants to the required user columns", async () => {

	const { rows } = await setup.query(`
        SELECT table_definition.relname, column_definition.attname,
               pg_catalog.has_column_privilege('medical_data_hub_locking_owner', table_definition.oid, column_definition.attnum, 'SELECT') AS can_select,
               pg_catalog.has_column_privilege('medical_data_hub_locking_owner', table_definition.oid, column_definition.attnum, 'UPDATE') AS can_update
        FROM pg_catalog.pg_class AS table_definition
        JOIN pg_catalog.pg_namespace AS schema_definition ON schema_definition.oid = table_definition.relnamespace
        JOIN pg_catalog.pg_attribute AS column_definition ON column_definition.attrelid = table_definition.oid
        WHERE schema_definition.nspname = 'public' AND table_definition.relname = 'users' AND table_definition.relkind = 'r'
          AND column_definition.attnum > 0 AND NOT column_definition.attisdropped
          AND (pg_catalog.has_column_privilege('medical_data_hub_locking_owner', table_definition.oid, column_definition.attnum, 'SELECT')
               OR pg_catalog.has_column_privilege('medical_data_hub_locking_owner', table_definition.oid, column_definition.attnum, 'UPDATE'))
        ORDER BY table_definition.relname, column_definition.attname
    `);
	expect(rows).toEqual([
		{ relname: "users", attname: "clinic_id", can_select: true, can_update: false },
		{ relname: "users", attname: "is_active", can_select: true, can_update: true },
		{ relname: "users", attname: "role", can_select: true, can_update: false },
		{ relname: "users", attname: "user_id", can_select: true, can_update: false },
	]);

});

it("uses the dedicated locking owner and trusted search path for both volatile functions", async () => {

	const names = lockFunctions.map(([name]) => name);
	const { rows } = await setup.query(
		`
        SELECT proname, pg_catalog.pg_get_userbyid(proowner) AS owner, prosecdef, provolatile, proconfig
        FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = ANY($1::text[]) ORDER BY proname
    `,
		[names],
	);
	expect(rows).toEqual(
		[...names]
			.sort()
			.map((proname) => ({
				proname,
				owner: "medical_data_hub_locking_owner",
				prosecdef: true,
				provolatile: "v",
				proconfig: ["search_path=pg_catalog, pg_temp"],
			})),
	);

});

it("denies preparatory user locking to the reception profile", async () => {

	for(const [name, query] of lockFunctions) {

		await api.query("BEGIN");
		try {
			await api.query("SET LOCAL ROLE reception");
			await expect(api.query(query, [null, null]), name).rejects.toMatchObject({ code: "42501" });
		} finally {
			await api.query("ROLLBACK");
		}

	}

});
