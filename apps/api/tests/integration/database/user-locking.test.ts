import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { Client, escapeIdentifier } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { User } from "../../../src/generated/prisma/client.js";

type LocalUser = Pick<User, "userId" | "clinicId" | "isActive"> & { role: string };

const setupConnectionString = process.env.DATABASE_SETUP_URL;
const apiConnectionString = process.env.DATABASE_URL;
if (!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const api = new Client({ connectionString: apiConnectionString });
const contender = new Client({ connectionString: apiConnectionString });
const profileNames = ["platform_administrator", "clinic_administrator", "reception", "healthcare_professional"];
const lookupOwners = ["medical_data_hub_identity_owner", "medical_data_hub_metadata_owner"];
const lockFunctions = [
	["lock_user_for_share", "SELECT * FROM public.lock_user_for_share($1::uuid, $2::uuid)"],
	["lock_user_for_no_key_update", "SELECT * FROM public.lock_user_for_no_key_update($1::uuid, $2::uuid)"],
] as const;
const outsiderRole = escapeIdentifier(`user_lock_test_${randomUUID().replaceAll("-", "")}`);
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
	await setup.query(`CREATE ROLE ${outsiderRole} NOLOGIN`);
});

afterAll(async () => {
	await setup.query(`DROP ROLE ${outsiderRole}`);
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

it.each(lockFunctions)("allows the actor to lock its own row through %s", async (_name, query) => {
	await api.query("BEGIN");
	try {
		const { rows } = await api.query(query, [actor.userId, actor.userId]);
		expect(rows).toEqual([
			{ user_id: actor.userId, clinic_id: actor.clinicId, role: actor.role, is_active: actor.isActive },
		]);
	} finally {
		await api.query("ROLLBACK");
	}
});

it.each(lockFunctions)("filters another clinic's user through %s", async (_name, query) => {
	const { rows } = await api.query(query, [actor.userId, otherActor.userId]);
	expect(rows).toEqual([]);
});

it.each(lockFunctions)("returns no row for missing or NULL actors through %s", async (_name, query) => {
	for (const actorId of [randomUUID(), null]) {
		const { rows } = await api.query(query, [actorId, target.userId]);
		expect(rows).toEqual([]);
	}
});

it.each(lockFunctions)("returns no row for missing or NULL targets through %s", async (_name, query) => {
	for (const targetId of [randomUUID(), null]) {
		const { rows } = await api.query(query, [actor.userId, targetId]);
		expect(rows).toEqual([]);
	}
});

it.each(lockFunctions)(
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

it.each(lockFunctions)("denies a clinic actor access to a platform user through %s", async (_name, query) => {
	const { rows } = await api.query(query, [actor.userId, platform.userId]);
	expect(rows).toEqual([]);
});

it.each(lockFunctions)(
	"returns inactive users and their current role without authorizing them through %s",
	async (_name, query) => {
		await setup.query("BEGIN");
		try {
			await setup.query(
				"UPDATE public.users SET role = 'reception', is_active = false WHERE user_id = $1::uuid",
				[target.userId],
			);
			await setup.query("SET LOCAL ROLE medical_data_hub_api");
			const { rows } = await setup.query(query, [actor.userId, target.userId]);
			expect(rows).toEqual([
				{ user_id: target.userId, clinic_id: target.clinicId, role: "reception", is_active: false },
			]);
		} finally {
			await setup.query("ROLLBACK");
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

it.each(lockFunctions)("locks only the requested target through %s", async (_name, query) => {
	await api.query("BEGIN");
	await setup.query("BEGIN");
	try {
		await api.query(query, [actor.userId, target.userId]);
		const actorRow = await setup.query(
			"SELECT user_id FROM public.users WHERE user_id = $1::uuid FOR UPDATE NOWAIT",
			[actor.userId],
		);
		expect(actorRow.rows).toEqual([{ user_id: actor.userId }]);
		await expect(
			setup.query("SELECT user_id FROM public.users WHERE user_id = $1::uuid FOR UPDATE NOWAIT", [target.userId]),
		).rejects.toMatchObject({ code: "55P03" });
	} finally {
		await setup.query("ROLLBACK");
		await api.query("ROLLBACK");
	}
});

it.each(["COMMIT", "ROLLBACK"])(
	"retains conflicting user locks until %s and releases them afterward",
	async (boundary) => {
		await api.query("BEGIN");
		await contender.query("BEGIN");
		try {
			await api.query("SELECT * FROM public.lock_user_for_share($1::uuid, $2::uuid)", [
				actor.userId,
				target.userId,
			]);
			await contender.query("SET LOCAL lock_timeout = '150ms'");
			await expect(
				contender.query("SELECT * FROM public.lock_user_for_no_key_update($1::uuid, $2::uuid)", [
					actor.userId,
					target.userId,
				]),
			).rejects.toMatchObject({ code: "55P03" });
			await contender.query("ROLLBACK");
			await api.query(boundary);
			const { rows } = await contender.query(
				"SELECT * FROM public.lock_user_for_no_key_update($1::uuid, $2::uuid)",
				[actor.userId, target.userId],
			);
			expect(rows).toEqual([
				{ user_id: target.userId, clinic_id: target.clinicId, role: target.role, is_active: target.isActive },
			]);
		} finally {
			await contender.query("ROLLBACK");
			await api.query("ROLLBACK");
		}
	},
);

it.each(lockFunctions)(
	"returns the committed user state after waiting for an update through %s",
	async (_name, query) => {
		const apiPid = (await api.query("SELECT pg_catalog.pg_backend_pid() AS pid")).rows[0].pid;
		const setupPid = (await setup.query("SELECT pg_catalog.pg_backend_pid() AS pid")).rows[0].pid;
		await setup.query("BEGIN");
		await setup.query("UPDATE public.users SET role = 'reception', is_active = false WHERE user_id = $1::uuid", [
			target.userId,
		]);
		await api.query("BEGIN ISOLATION LEVEL READ COMMITTED");
		const pendingRead = api.query(query, [actor.userId, target.userId]).catch((error: unknown) => error);
		let updateCommitted = false;
		try {
			let isWaiting = false;
			for (let attempt = 0; attempt < 100; attempt++) {
				const { rows } = await setup.query(
					"SELECT $2::int = ANY(pg_catalog.pg_blocking_pids($1::int)) AS waiting",
					[apiPid, setupPid],
				);
				if (rows[0].waiting) {
					isWaiting = true;
					break;
				}
				await setTimeout(10);
			}
			expect(isWaiting).toBe(true);
			await setup.query("COMMIT");
			updateCommitted = true;
			expect(await pendingRead).toMatchObject({
				rows: [{ user_id: target.userId, clinic_id: target.clinicId, role: "reception", is_active: false }],
			});
		} finally {
			await setup.query("ROLLBACK");
			await pendingRead;
			await api.query("ROLLBACK");
			if (updateCommitted) {
				await setup.query(
					"UPDATE public.users SET role = $2::public.user_role, is_active = $3 WHERE user_id = $1::uuid",
					[target.userId, target.role, target.isActive],
				);
			}
		}
	},
);

it("enables row-level security on users", async () => {
	const { rows } = await setup.query(
		"SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.users'::regclass",
	);
	expect(rows).toEqual([{ relrowsecurity: true }]);
});

it.each(profileNames)("keeps the %s profile outside preparatory user RLS exceptions", async (profileName) => {
	await setup.query("BEGIN");
	try {
		await setup.query(`GRANT SELECT (user_id) ON public.users TO ${escapeIdentifier(profileName)}`);
		await setup.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		const { rows } = await setup.query("SELECT user_id FROM public.users");
		expect(rows).toEqual([]);
	} finally {
		await setup.query("ROLLBACK");
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

it("rejects unchanged activity assignments by the locking owner through RLS", async () => {
	await setup.query("BEGIN");
	try {
		await setup.query("SET LOCAL ROLE medical_data_hub_locking_owner");
		await expect(
			setup.query("UPDATE public.users SET is_active = is_active WHERE user_id = $1::uuid", [target.userId]),
		).rejects.toMatchObject({
			code: "42501",
			message: 'new row violates row-level security policy for table "users"',
		});
	} finally {
		await setup.query("ROLLBACK");
	}
});

it.each([
	["identity reads", "SELECT identity_id FROM public.users LIMIT 1"],
	["role updates", "UPDATE public.users SET role = role WHERE false"],
	["user deletion", "DELETE FROM public.users WHERE false"],
	["user truncation", "TRUNCATE public.users"],
	["patient contact reads", "SELECT email, phone FROM public.patients LIMIT 1"],
	["clinical note reads", "SELECT content FROM public.clinical_notes LIMIT 1"],
])("denies locking owner access to %s", async (_name, query) => {
	await setup.query("BEGIN");
	try {
		await setup.query("SET LOCAL ROLE medical_data_hub_locking_owner");
		await expect(setup.query(query)).rejects.toMatchObject({ code: "42501" });
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

it("keeps the locking owner without login, administrative, or schema creation privileges", async () => {
	const { rows } = await setup.query(`
        SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls,
               pg_catalog.has_schema_privilege(rolname, 'public', 'CREATE') AS can_create
        FROM pg_catalog.pg_roles WHERE rolname = 'medical_data_hub_locking_owner'
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

it("keeps application roles and lookup owners outside locking owner membership", async () => {
	const names = ["medical_data_hub_api", ...profileNames, ...lookupOwners];
	const { rows } = await setup.query(
		`
        SELECT rolname, pg_catalog.pg_has_role(rolname, 'medical_data_hub_locking_owner', 'MEMBER') AS member
        FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname
    `,
		[names],
	);
	expect(rows).toEqual([...names].sort().map((rolname) => ({ rolname, member: false })));
});

it("denies selection of the locking owner by the API login", async () => {
	await expect(api.query("SET ROLE medical_data_hub_locking_owner")).rejects.toMatchObject({ code: "42501" });
});

it.each(profileNames)("denies preparatory user locking to the %s profile", async (profileName) => {
	for (const [name, query] of lockFunctions) {
		await api.query("BEGIN");
		try {
			await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
			await expect(api.query(query, [null, null]), name).rejects.toMatchObject({ code: "42501" });
		} finally {
			await api.query("ROLLBACK");
		}
	}
});

it.each(lockFunctions)("denies %s execution through PUBLIC privileges", async (_name, query) => {
	await setup.query("BEGIN");
	try {
		await setup.query(`SET LOCAL ROLE ${outsiderRole}`);
		await expect(setup.query(query, [null, null])).rejects.toMatchObject({ code: "42501" });
	} finally {
		await setup.query("ROLLBACK");
	}
});

it.each(lookupOwners)("denies user locking to %s", async (ownerName) => {
	for (const [name, query] of lockFunctions) {
		await setup.query("BEGIN");
		try {
			await setup.query(`SET LOCAL ROLE ${escapeIdentifier(ownerName)}`);
			await expect(setup.query(query, [null, null]), name).rejects.toMatchObject({ code: "42501" });
		} finally {
			await setup.query("ROLLBACK");
		}
	}
});

it("keeps caller role and direct user access unchanged after locking", async () => {
	await api.query("BEGIN");
	try {
		await api.query("SELECT * FROM public.lock_user_for_share($1::uuid, $2::uuid)", [actor.userId, target.userId]);
		const { rows } = await api.query("SELECT current_user AS role");
		expect(rows).toEqual([{ role: "medical_data_hub_api" }]);
		await expect(api.query("SELECT user_id, clinic_id, role, is_active FROM public.users")).rejects.toMatchObject({
			code: "42501",
		});
	} finally {
		await api.query("ROLLBACK");
	}
});

it.each(lockFunctions)("ignores a caller temporary user table and search path through %s", async (_name, query) => {
	await api.query("BEGIN");
	try {
		await api.query(
			"CREATE TEMP TABLE users (user_id uuid, clinic_id uuid, role public.user_role, is_active boolean) ON COMMIT DROP",
		);
		const fakeClinicId = randomUUID();
		await api.query(
			`INSERT INTO pg_temp.users (user_id, clinic_id, role, is_active)
            VALUES ($1::uuid, $3::uuid, 'reception', true), ($2::uuid, $3::uuid, 'platform_administrator', false)`,
			[actor.userId, target.userId, fakeClinicId],
		);
		await api.query("GRANT SELECT ON pg_temp.users TO medical_data_hub_locking_owner");
		await api.query("GRANT UPDATE (is_active) ON pg_temp.users TO medical_data_hub_locking_owner");
		await api.query("SET LOCAL search_path = pg_temp, public");
		const { rows } = await api.query(query, [actor.userId, target.userId]);
		expect(rows).toEqual([
			{ user_id: target.userId, clinic_id: target.clinicId, role: target.role, is_active: target.isActive },
		]);
	} finally {
		await api.query("ROLLBACK");
	}
});
