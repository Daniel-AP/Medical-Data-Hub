import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { Client, escapeIdentifier } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { Service, User } from "../../../src/generated/prisma/client.js";

const setupConnectionString = process.env.DATABASE_SETUP_URL;
const apiConnectionString = process.env.DATABASE_URL;
if (!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const api = new Client({ connectionString: apiConnectionString });
const contender = new Client({ connectionString: apiConnectionString });
const lockQuery = "SELECT * FROM public.lock_service_for_share($1::uuid)";
const outsiderRole = escapeIdentifier(`service_lock_test_${randomUUID().replaceAll("-", "")}`);
let actor: Pick<User, "userId" | "clinicId">;
let target: Service;
let otherService: Service;
let foreignService: Service;

beforeAll(async () => {
	await setup.connect();
	await api.connect();
	await contender.connect();
	const actors = await setup.query<Pick<User, "userId" | "clinicId">>(`
        SELECT user_id AS "userId", clinic_id AS "clinicId"
        FROM public.users WHERE role = 'reception' ORDER BY clinic_id, user_id LIMIT 1
    `);
	actor = actors.rows[0];
	const services = await setup.query<Service>(`
        SELECT service_id AS "serviceId", clinic_id AS "clinicId", name, duration_minutes AS "durationMinutes",
            specialty_id AS "specialtyId", is_active AS "isActive"
        FROM public.services ORDER BY service_id
    `);
	[target, otherService] = services.rows.filter((service) => service.clinicId === actor.clinicId);
	foreignService = services.rows.find((service) => service.clinicId !== actor.clinicId)!;
	await setup.query(`CREATE ROLE ${outsiderRole} NOLOGIN`);
});

beforeEach(async () => {
	await api.query("BEGIN ISOLATION LEVEL READ COMMITTED");
	await api.query(
		`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
		[actor.userId, actor.clinicId],
	);
	await api.query("SET LOCAL ROLE reception");
});

afterEach(async () => {
	await setup.query("ROLLBACK");
	await contender.query("ROLLBACK");
	await api.query("ROLLBACK");
});

afterAll(async () => {
	await setup.query(`DROP ROLE ${outsiderRole}`);
	await contender.end();
	await api.end();
	await setup.end();
});

it("returns only the protected service identifiers, duration, specialty, and activity", async () => {
	const result = await api.query(lockQuery, [target.serviceId]);
	expect(result.fields.map((field) => field.name)).toEqual([
		"service_id",
		"clinic_id",
		"duration_minutes",
		"specialty_id",
		"is_active",
	]);
	expect(result.rows).toEqual([
		{
			service_id: target.serviceId,
			clinic_id: target.clinicId,
			duration_minutes: target.durationMinutes,
			specialty_id: target.specialtyId,
			is_active: target.isActive,
		},
	]);
});

it("returns inactive services without authorizing their use", async () => {
	await api.query("SET LOCAL ROLE clinic_administrator");
	await api.query("UPDATE public.services SET is_active = false WHERE service_id = $1::uuid", [target.serviceId]);
	await api.query("SET LOCAL ROLE reception");
	const { rows } = await api.query(lockQuery, [target.serviceId]);
	expect(rows).toEqual([
		{
			service_id: target.serviceId,
			clinic_id: target.clinicId,
			duration_minutes: target.durationMinutes,
			specialty_id: target.specialtyId,
			is_active: false,
		},
	]);
});

it.each(["missing", "NULL"])("returns no service row for a %s target", async (kind) => {
	const { rows } = await api.query(lockQuery, [kind === "missing" ? randomUUID() : null]);
	expect(rows).toEqual([]);
});

it("filters and does not lock another clinic's service", async () => {
	const { rows } = await api.query(lockQuery, [foreignService.serviceId]);
	expect(rows).toEqual([]);
	await setup.query("BEGIN");
	const unlocked = await setup.query(
		"SELECT service_id FROM public.services WHERE service_id = $1::uuid FOR UPDATE NOWAIT",
		[foreignService.serviceId],
	);
	expect(unlocked.rows).toEqual([{ service_id: foreignService.serviceId }]);
});

it.each([
	{ field: "app.user_id", value: "", label: "an empty actor" },
	{ field: "app.clinic_id", value: "", label: "an empty clinic" },
	{ field: "app.user_id", value: null, label: "a reset actor" },
	{ field: "app.clinic_id", value: null, label: "a reset clinic" },
])("filters service locking with $label", async ({ field, value }) => {
	await api.query("SELECT pg_catalog.set_config($1, $2, true)", [field, value]);
	const { rows } = await api.query(lockQuery, [target.serviceId]);
	expect(rows).toEqual([]);
});

it.each(["app.user_id", "app.clinic_id"])("rejects malformed %s UUIDs during service locking", async (field) => {
	await api.query("SELECT pg_catalog.set_config($1, 'not-a-uuid', true)", [field]);
	await expect(api.query(lockQuery, [target.serviceId])).rejects.toMatchObject({ code: "22P02" });
});

it("filters service locking on a connection without context settings", async () => {
	const fresh = new Client({ connectionString: apiConnectionString });
	await fresh.connect();
	try {
		await fresh.query("BEGIN");
		await fresh.query("SET LOCAL ROLE reception");
		expect((await fresh.query(lockQuery, [target.serviceId])).rows).toEqual([]);
	} finally {
		await fresh.query("ROLLBACK");
		await fresh.end();
	}
});

it("allows simultaneous reception callers to share the service lock", async () => {
	await api.query(lockQuery, [target.serviceId]);
	await contender.query("BEGIN");
	await contender.query("SET LOCAL lock_timeout = '150ms'");
	await contender.query(
		`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
		[actor.userId, actor.clinicId],
	);
	await contender.query("SET LOCAL ROLE reception");
	const { rows } = await contender.query(lockQuery, [target.serviceId]);
	expect(rows).toHaveLength(1);
	expect(rows[0].service_id).toBe(target.serviceId);
});

it("acquires FOR SHARE rather than a weaker or exclusive service lock", async () => {
	await api.query(lockQuery, [target.serviceId]);
	await setup.query("BEGIN");
	const shared = await setup.query(
		"SELECT service_id FROM public.services WHERE service_id = $1::uuid FOR SHARE NOWAIT",
		[target.serviceId],
	);
	expect(shared.rows).toEqual([{ service_id: target.serviceId }]);
	await expect(
		setup.query("SELECT service_id FROM public.services WHERE service_id = $1::uuid FOR NO KEY UPDATE NOWAIT", [
			target.serviceId,
		]),
	).rejects.toMatchObject({ code: "55P03" });
});

it("locks only the requested service row", async () => {
	await api.query(lockQuery, [target.serviceId]);
	await setup.query("BEGIN");
	const other = await setup.query(
		"SELECT service_id FROM public.services WHERE service_id = $1::uuid FOR UPDATE NOWAIT",
		[otherService.serviceId],
	);
	expect(other.rows).toEqual([{ service_id: otherService.serviceId }]);
	const actorRow = await setup.query("SELECT user_id FROM public.users WHERE user_id = $1::uuid FOR UPDATE NOWAIT", [
		actor.userId,
	]);
	expect(actorRow.rows).toEqual([{ user_id: actor.userId }]);
	await expect(
		setup.query("SELECT service_id FROM public.services WHERE service_id = $1::uuid FOR UPDATE NOWAIT", [
			target.serviceId,
		]),
	).rejects.toMatchObject({ code: "55P03" });
});

it.each(["COMMIT", "ROLLBACK"])("blocks service changes until %s and releases the lock afterward", async (boundary) => {
	await api.query(lockQuery, [target.serviceId]);
	await contender.query("BEGIN");
	await contender.query("SET LOCAL lock_timeout = '150ms'");
	await contender.query(
		`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
		[actor.userId, actor.clinicId],
	);
	await contender.query("SET LOCAL ROLE clinic_administrator");
	await expect(
		contender.query(
			"UPDATE public.services SET duration_minutes = duration_minutes + 15 WHERE service_id = $1::uuid",
			[target.serviceId],
		),
	).rejects.toMatchObject({ code: "55P03" });
	await contender.query("ROLLBACK");
	await api.query(boundary);
	await contender.query("BEGIN");
	await contender.query("SET LOCAL lock_timeout = '150ms'");
	await contender.query(
		`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
		[actor.userId, actor.clinicId],
	);
	await contender.query("SET LOCAL ROLE clinic_administrator");
	const updated = await contender.query(
		"UPDATE public.services SET duration_minutes = duration_minutes + 15 WHERE service_id = $1::uuid RETURNING duration_minutes",
		[target.serviceId],
	);
	expect(updated.rows).toEqual([{ duration_minutes: target.durationMinutes + 15 }]);
});

it("returns committed service values after waiting for a concurrent edit", async () => {
	const fixture = await setup.query(
		`INSERT INTO public.services (clinic_id, name, duration_minutes, specialty_id)
        VALUES ($1::uuid, 'Synthetic lock fixture', 30, $2::uuid) RETURNING service_id`,
		[target.clinicId, target.specialtyId],
	);
	const serviceId = fixture.rows[0].service_id;
	const apiPid = (await api.query("SELECT pg_catalog.pg_backend_pid() AS pid")).rows[0].pid;
	const setupPid = (await setup.query("SELECT pg_catalog.pg_backend_pid() AS pid")).rows[0].pid;
	await setup.query("BEGIN");
	await setup.query(
		"UPDATE public.services SET duration_minutes = 45, is_active = false WHERE service_id = $1::uuid",
		[serviceId],
	);
	const pendingRead = api.query(lockQuery, [serviceId]).catch((error: unknown) => error);
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
		expect(await pendingRead).toMatchObject({
			rows: [
				{
					service_id: serviceId,
					clinic_id: target.clinicId,
					duration_minutes: 45,
					specialty_id: target.specialtyId,
					is_active: false,
				},
			],
		});
	} finally {
		await setup.query("ROLLBACK");
		await pendingRead;
		await api.query("ROLLBACK");
		await setup.query("DELETE FROM public.services WHERE service_id = $1::uuid", [serviceId]);
	}
});

it("keeps reception unable to lock services directly", async () => {
	await api.query(lockQuery, [target.serviceId]);
	await expect(
		api.query("SELECT service_id FROM public.services WHERE service_id = $1::uuid FOR SHARE", [target.serviceId]),
	).rejects.toMatchObject({ code: "42501" });
});

it("keeps reception unable to modify services after calling the locking function", async () => {
	await api.query(lockQuery, [target.serviceId]);
	expect((await api.query("SELECT current_user AS role")).rows).toEqual([{ role: "reception" }]);
	await expect(
		api.query("UPDATE public.services SET is_active = false WHERE service_id = $1::uuid", [target.serviceId]),
	).rejects.toMatchObject({ code: "42501" });
});

it("preserves direct service locking by clinic administrators", async () => {
	await api.query("SET LOCAL ROLE clinic_administrator");
	const { rows } = await api.query("SELECT service_id FROM public.services WHERE service_id = $1::uuid FOR SHARE", [
		target.serviceId,
	]);
	expect(rows).toEqual([{ service_id: target.serviceId }]);
});

it.each(["medical_data_hub_api", "platform_administrator", "clinic_administrator", "healthcare_professional"])(
	"denies service locking function execution to %s",
	async (profileName) => {
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		await expect(api.query(lockQuery, [target.serviceId])).rejects.toMatchObject({ code: "42501" });
	},
);

it.each(["medical_data_hub_identity_owner", "medical_data_hub_metadata_owner"])(
	"denies service locking function execution to %s",
	async (ownerName) => {
		await setup.query("BEGIN");
		await setup.query(`SET LOCAL ROLE ${escapeIdentifier(ownerName)}`);
		await expect(setup.query(lockQuery, [target.serviceId])).rejects.toMatchObject({ code: "42501" });
	},
);

it("denies service locking execution through PUBLIC privileges", async () => {
	await setup.query("BEGIN");
	await setup.query(`SET LOCAL ROLE ${outsiderRole}`);
	await expect(setup.query(lockQuery, [target.serviceId])).rejects.toMatchObject({ code: "42501" });
});

it.each(["is_active = false", "is_active = is_active"])(
	"rejects locking owner service writes using %s",
	async (assignment) => {
		await setup.query("BEGIN");
		await setup.query(
			`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
			[actor.userId, actor.clinicId],
		);
		await setup.query("SET LOCAL ROLE medical_data_hub_locking_owner");
		expect(
			(
				await setup.query("SELECT service_id FROM public.services WHERE service_id = $1::uuid", [
					target.serviceId,
				])
			).rows,
		).toEqual([{ service_id: target.serviceId }]);
		await expect(
			setup.query(`UPDATE public.services SET ${assignment} WHERE service_id = $1::uuid`, [target.serviceId]),
		).rejects.toMatchObject({
			code: "42501",
			message: 'new row violates row-level security policy for table "services"',
		});
	},
);

it.each([
	["service name reads", "SELECT name FROM public.services"],
	["service name updates", "UPDATE public.services SET name = name WHERE false"],
	["service duration updates", "UPDATE public.services SET duration_minutes = duration_minutes WHERE false"],
	[
		"service inserts",
		"INSERT INTO public.services (clinic_id, name, duration_minutes, specialty_id) VALUES (NULL, 'Synthetic service', 30, NULL)",
	],
	["service deletion", "DELETE FROM public.services WHERE false"],
	["service truncation", "TRUNCATE public.services"],
])("denies locking owner access to %s", async (_name, query) => {
	await setup.query("BEGIN");
	await setup.query("SET LOCAL ROLE medical_data_hub_locking_owner");
	await expect(setup.query(query)).rejects.toMatchObject({ code: "42501" });
});

it("limits locking owner service grants to the five read columns and activity locking column", async () => {
	const { rows } = await setup.query(`
        SELECT attribute.attname,
            pg_catalog.has_column_privilege('medical_data_hub_locking_owner', attribute.attrelid, attribute.attnum, 'SELECT') AS can_select,
            pg_catalog.has_column_privilege('medical_data_hub_locking_owner', attribute.attrelid, attribute.attnum, 'UPDATE') AS can_update
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.services'::regclass AND attribute.attnum > 0 AND NOT attribute.attisdropped
        ORDER BY attribute.attname
    `);
	expect(rows).toEqual([
		{ attname: "clinic_id", can_select: true, can_update: false },
		{ attname: "duration_minutes", can_select: true, can_update: false },
		{ attname: "is_active", can_select: true, can_update: true },
		{ attname: "name", can_select: false, can_update: false },
		{ attname: "service_id", can_select: true, can_update: false },
		{ attname: "specialty_id", can_select: true, can_update: false },
	]);
});

it("uses the dedicated locking owner and trusted search path for the volatile service function", async () => {
	const { rows } = await setup.query(`
        SELECT pg_catalog.pg_get_userbyid(proowner) AS owner, prosecdef, provolatile, proconfig
        FROM pg_catalog.pg_proc WHERE oid = 'public.lock_service_for_share(uuid)'::regprocedure
    `);
	expect(rows).toEqual([
		{
			owner: "medical_data_hub_locking_owner",
			prosecdef: true,
			provolatile: "v",
			proconfig: ["search_path=pg_catalog, pg_temp"],
		},
	]);
});

it("grants service locking execution only to reception besides the owner", async () => {
	const { rows } = await setup.query(`
        SELECT pg_catalog.pg_get_userbyid(privilege.grantee) AS grantee, privilege.privilege_type, privilege.is_grantable
        FROM pg_catalog.pg_proc AS function_definition
        CROSS JOIN LATERAL pg_catalog.aclexplode(function_definition.proacl) AS privilege
        WHERE function_definition.oid = 'public.lock_service_for_share(uuid)'::regprocedure
            AND privilege.grantee <> function_definition.proowner
        ORDER BY privilege.grantee
    `);
	expect(rows).toEqual([{ grantee: "reception", privilege_type: "EXECUTE", is_grantable: false }]);
});

it("ignores a caller temporary service table and search path", async () => {
	await api.query(
		"CREATE TEMP TABLE services (service_id uuid, clinic_id uuid, duration_minutes integer, specialty_id uuid, is_active boolean) ON COMMIT DROP",
	);
	await api.query("INSERT INTO pg_temp.services VALUES ($1::uuid, $2::uuid, 999, $3::uuid, false)", [
		target.serviceId,
		target.clinicId,
		target.specialtyId,
	]);
	await api.query("GRANT SELECT ON pg_temp.services TO medical_data_hub_locking_owner");
	await api.query("GRANT UPDATE (is_active) ON pg_temp.services TO medical_data_hub_locking_owner");
	await api.query("SET LOCAL search_path = pg_temp, public");
	const { rows } = await api.query(lockQuery, [target.serviceId]);
	expect(rows).toEqual([
		{
			service_id: target.serviceId,
			clinic_id: target.clinicId,
			duration_minutes: target.durationMinutes,
			specialty_id: target.specialtyId,
			is_active: target.isActive,
		},
	]);
});
