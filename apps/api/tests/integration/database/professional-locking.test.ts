import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { Client, escapeIdentifier } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { Professional, User } from "../../../src/generated/prisma/client.js";

const setupConnectionString = process.env.DATABASE_SETUP_URL;
const apiConnectionString = process.env.DATABASE_URL;
if (!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const api = new Client({ connectionString: apiConnectionString });
const contender = new Client({ connectionString: apiConnectionString });
const lockFunctions = [
	{
		functionName: "lock_professional_for_no_key_update",
		profileName: "reception",
		query: "SELECT * FROM public.lock_professional_for_no_key_update($1::uuid)",
	},
	{
		functionName: "lock_own_professional_for_no_key_update",
		profileName: "healthcare_professional",
		query: "SELECT * FROM public.lock_own_professional_for_no_key_update()",
	},
] as const;
const invalidContexts = [
	{ field: "app.user_id", value: "", label: "an empty actor", malformed: false },
	{ field: "app.clinic_id", value: "", label: "an empty clinic", malformed: false },
	{ field: "app.user_id", value: null, label: "a reset actor", malformed: false },
	{ field: "app.clinic_id", value: null, label: "a reset clinic", malformed: false },
	{ field: "app.user_id", value: "not-a-uuid", label: "a malformed actor", malformed: true },
	{ field: "app.clinic_id", value: "not-a-uuid", label: "a malformed clinic", malformed: true },
];
const outsiderRole = escapeIdentifier(`professional_lock_test_${randomUUID().replaceAll("-", "")}`);
let actor: Pick<User, "userId" | "clinicId">;
let target: Professional;
let otherProfessional: Professional;
let foreignProfessional: Professional;
let otherSpecialtyId: string;

beforeAll(async () => {
	await setup.connect();
	await api.connect();
	await contender.connect();
	const actors = await setup.query<Pick<User, "userId" | "clinicId">>(`
        SELECT user_id AS "userId", clinic_id AS "clinicId"
        FROM public.users WHERE role = 'reception' ORDER BY clinic_id, user_id LIMIT 1
    `);
	actor = actors.rows[0];
	const professionals = await setup.query<Professional>(`
        SELECT professional_id AS "professionalId", clinic_id AS "clinicId", user_id AS "userId", specialty_id AS "specialtyId"
        FROM public.professionals ORDER BY professional_id
    `);
	[target, otherProfessional] = professionals.rows.filter((professional) => professional.clinicId === actor.clinicId);
	foreignProfessional = professionals.rows.find((professional) => professional.clinicId !== actor.clinicId)!;
	const specialty = await setup.query(
		"SELECT specialty_id FROM public.specialties WHERE clinic_id = $1::uuid AND specialty_id <> $2::uuid ORDER BY specialty_id LIMIT 1",
		[target.clinicId, target.specialtyId],
	);
	otherSpecialtyId = specialty.rows[0].specialty_id;
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

it.each(lockFunctions)(
	"returns only four professional identifiers through $functionName",
	async ({ profileName, query }) => {
		const actorId = profileName === "reception" ? actor.userId : target.userId;
		await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actorId]);
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		const result = await api.query(query, profileName === "reception" ? [target.professionalId] : []);
		expect(result.fields.map((field) => field.name)).toEqual([
			"professional_id",
			"clinic_id",
			"user_id",
			"specialty_id",
		]);
		expect(result.rows).toEqual([
			{
				professional_id: target.professionalId,
				clinic_id: target.clinicId,
				user_id: target.userId,
				specialty_id: target.specialtyId,
			},
		]);
	},
);

it("allows reception to lock another professional in the same clinic", async () => {
	const { rows } = await api.query(lockFunctions[0].query, [otherProfessional.professionalId]);
	expect(rows).toEqual([
		{
			professional_id: otherProfessional.professionalId,
			clinic_id: otherProfessional.clinicId,
			user_id: otherProfessional.userId,
			specialty_id: otherProfessional.specialtyId,
		},
	]);
});

it("filters and does not lock another clinic's professional", async () => {
	expect((await api.query(lockFunctions[0].query, [foreignProfessional.professionalId])).rows).toEqual([]);
	await setup.query("BEGIN");
	const unlocked = await setup.query(
		"SELECT professional_id FROM public.professionals WHERE professional_id = $1::uuid FOR UPDATE NOWAIT",
		[foreignProfessional.professionalId],
	);
	expect(unlocked.rows).toEqual([{ professional_id: foreignProfessional.professionalId }]);
});

it.each(["missing", "NULL"])("returns no professional row for a %s reception target", async (kind) => {
	const { rows } = await api.query(lockFunctions[0].query, [kind === "missing" ? randomUUID() : null]);
	expect(rows).toEqual([]);
});

it.each(["unassociated", "missing"])("returns no own professional for the %s actor", async (kind) => {
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [
		kind === "unassociated" ? actor.userId : randomUUID(),
	]);
	await api.query("SET LOCAL ROLE healthcare_professional");
	expect((await api.query(lockFunctions[1].query)).rows).toEqual([]);
});

it("filters own professional locking when the context clinic does not match the user's profile", async () => {
	await api.query(
		`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
		[target.userId, foreignProfessional.clinicId],
	);
	await api.query("SET LOCAL ROLE healthcare_professional");
	expect((await api.query(lockFunctions[1].query)).rows).toEqual([]);
	await setup.query("BEGIN");
	const unlocked = await setup.query(
		"SELECT professional_id FROM public.professionals WHERE professional_id = $1::uuid FOR UPDATE NOWAIT",
		[target.professionalId],
	);
	expect(unlocked.rows).toEqual([{ professional_id: target.professionalId }]);
});

it.each(lockFunctions.flatMap((lock) => invalidContexts.map((context) => ({ ...lock, ...context }))))(
	"restricts $functionName with $label",
	async ({ profileName, query, field, value, malformed }) => {
		const actorId = profileName === "reception" ? actor.userId : target.userId;
		await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actorId]);
		await api.query("SELECT pg_catalog.set_config($1, $2, true)", [field, value]);
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		const result = api.query(query, profileName === "reception" ? [target.professionalId] : []);
		if (malformed) {
			await expect(result).rejects.toMatchObject({ code: "22P02" });
		} else {
			expect((await result).rows).toEqual([]);
		}
	},
);

it.each(lockFunctions)(
	"filters $functionName on a connection without context settings",
	async ({ profileName, query }) => {
		const fresh = new Client({ connectionString: apiConnectionString });
		await fresh.connect();
		try {
			await fresh.query("BEGIN");
			await fresh.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
			const { rows } = await fresh.query(query, profileName === "reception" ? [target.professionalId] : []);
			expect(rows).toEqual([]);
		} finally {
			await fresh.query("ROLLBACK");
			await fresh.end();
		}
	},
);

it.each(lockFunctions)("acquires FOR NO KEY UPDATE through $functionName", async ({ profileName, query }) => {
	const actorId = profileName === "reception" ? actor.userId : target.userId;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actorId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	await api.query(query, profileName === "reception" ? [target.professionalId] : []);
	await setup.query("BEGIN");
	const compatible = await setup.query(
		"SELECT professional_id FROM public.professionals WHERE professional_id = $1::uuid FOR KEY SHARE NOWAIT",
		[target.professionalId],
	);
	expect(compatible.rows).toEqual([{ professional_id: target.professionalId }]);
	await expect(
		setup.query(
			"SELECT professional_id FROM public.professionals WHERE professional_id = $1::uuid FOR SHARE NOWAIT",
			[target.professionalId],
		),
	).rejects.toMatchObject({ code: "55P03" });
});

it.each(lockFunctions)(
	"locks only the selected professional row through $functionName",
	async ({ profileName, query }) => {
		const actorId = profileName === "reception" ? actor.userId : target.userId;
		await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actorId]);
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		await api.query(query, profileName === "reception" ? [target.professionalId] : []);
		await setup.query("BEGIN");
		const other = await setup.query(
			"SELECT professional_id FROM public.professionals WHERE professional_id = $1::uuid FOR UPDATE NOWAIT",
			[otherProfessional.professionalId],
		);
		expect(other.rows).toEqual([{ professional_id: otherProfessional.professionalId }]);
		const actorRow = await setup.query(
			"SELECT user_id FROM public.users WHERE user_id = $1::uuid FOR UPDATE NOWAIT",
			[actorId],
		);
		expect(actorRow.rows).toEqual([{ user_id: actorId }]);
		await expect(
			setup.query(
				"SELECT professional_id FROM public.professionals WHERE professional_id = $1::uuid FOR UPDATE NOWAIT",
				[target.professionalId],
			),
		).rejects.toMatchObject({ code: "55P03" });
	},
);

it.each(lockFunctions.flatMap((lock) => ["COMMIT", "ROLLBACK"].map((boundary) => ({ ...lock, boundary }))))(
	"coordinates both professional functions until $boundary after $functionName",
	async ({ profileName, query, boundary }) => {
		const actorId = profileName === "reception" ? actor.userId : target.userId;
		const competing = lockFunctions.find((lock) => lock.profileName !== profileName)!;
		const competingActorId = competing.profileName === "reception" ? actor.userId : target.userId;
		const competingValues = competing.profileName === "reception" ? [target.professionalId] : [];
		await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actorId]);
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		await api.query(query, profileName === "reception" ? [target.professionalId] : []);
		await contender.query("BEGIN");
		await contender.query("SET LOCAL lock_timeout = '150ms'");
		await contender.query(
			`SELECT pg_catalog.set_config('app.user_id', $1, true),
                pg_catalog.set_config('app.clinic_id', $2, true)`,
			[competingActorId, target.clinicId],
		);
		await contender.query(`SET LOCAL ROLE ${escapeIdentifier(competing.profileName)}`);
		await expect(contender.query(competing.query, competingValues)).rejects.toMatchObject({ code: "55P03" });
		await contender.query("ROLLBACK");
		await api.query(boundary);
		await contender.query("BEGIN");
		await contender.query("SET LOCAL lock_timeout = '150ms'");
		await contender.query(
			`SELECT pg_catalog.set_config('app.user_id', $1, true),
                pg_catalog.set_config('app.clinic_id', $2, true)`,
			[competingActorId, target.clinicId],
		);
		await contender.query(`SET LOCAL ROLE ${escapeIdentifier(competing.profileName)}`);
		const { rows } = await contender.query(competing.query, competingValues);
		expect(rows).toEqual([
			{
				professional_id: target.professionalId,
				clinic_id: target.clinicId,
				user_id: target.userId,
				specialty_id: target.specialtyId,
			},
		]);
	},
);

it.each(lockFunctions)(
	"waits for a concurrent professional lock through $functionName",
	async ({ profileName, query }) => {
		const actorId = profileName === "reception" ? actor.userId : target.userId;
		await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actorId]);
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		const apiPid = (await api.query("SELECT pg_catalog.pg_backend_pid() AS pid")).rows[0].pid;
		const setupPid = (await setup.query("SELECT pg_catalog.pg_backend_pid() AS pid")).rows[0].pid;
		await setup.query("BEGIN");
		await setup.query(
			"SELECT professional_id FROM public.professionals WHERE professional_id = $1::uuid FOR NO KEY UPDATE",
			[target.professionalId],
		);
		const pendingRead = api
			.query(query, profileName === "reception" ? [target.professionalId] : [])
			.catch((error: unknown) => error);
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
						professional_id: target.professionalId,
						clinic_id: target.clinicId,
						user_id: target.userId,
						specialty_id: target.specialtyId,
					},
				],
			});
		} finally {
			await setup.query("ROLLBACK");
			await pendingRead;
		}
	},
);

it.each(lockFunctions)("keeps $profileName unable to lock professionals directly", async ({ profileName, query }) => {
	const actorId = profileName === "reception" ? actor.userId : target.userId;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actorId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	await api.query(query, profileName === "reception" ? [target.professionalId] : []);
	await expect(
		api.query(
			"SELECT professional_id FROM public.professionals WHERE professional_id = $1::uuid FOR NO KEY UPDATE",
			[target.professionalId],
		),
	).rejects.toMatchObject({ code: "42501" });
});

it.each(lockFunctions)(
	"keeps $profileName unable to modify professionals after function execution",
	async ({ profileName, query }) => {
		const actorId = profileName === "reception" ? actor.userId : target.userId;
		await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actorId]);
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		await api.query(query, profileName === "reception" ? [target.professionalId] : []);
		expect((await api.query("SELECT current_user AS role")).rows).toEqual([{ role: profileName }]);
		await expect(
			api.query("UPDATE public.professionals SET specialty_id = specialty_id WHERE professional_id = $1::uuid", [
				target.professionalId,
			]),
		).rejects.toMatchObject({ code: "42501" });
	},
);

it("preserves direct professional locking by clinic administrators", async () => {
	await api.query("SET LOCAL ROLE clinic_administrator");
	const { rows } = await api.query(
		"SELECT professional_id FROM public.professionals WHERE professional_id = $1::uuid FOR NO KEY UPDATE",
		[target.professionalId],
	);
	expect(rows).toEqual([{ professional_id: target.professionalId }]);
});

const deniedProfiles = lockFunctions.flatMap((lock) =>
	[
		"medical_data_hub_api",
		"platform_administrator",
		"clinic_administrator",
		lock.profileName === "reception" ? "healthcare_professional" : "reception",
	].map((profileName) => ({ ...lock, profileName })),
);

it.each(deniedProfiles)(
	"denies $functionName execution to $profileName",
	async ({ profileName, query, functionName }) => {
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		const values = functionName === "lock_professional_for_no_key_update" ? [target.professionalId] : [];
		await expect(api.query(query, values)).rejects.toMatchObject({ code: "42501" });
	},
);

it.each(
	lockFunctions.flatMap((lock) =>
		["medical_data_hub_identity_owner", "medical_data_hub_metadata_owner"].map((ownerName) => ({
			...lock,
			ownerName,
		})),
	),
)("denies $functionName execution to $ownerName", async ({ profileName, query, ownerName }) => {
	await setup.query("BEGIN");
	await setup.query(`SET LOCAL ROLE ${escapeIdentifier(ownerName)}`);
	await expect(setup.query(query, profileName === "reception" ? [target.professionalId] : [])).rejects.toMatchObject({
		code: "42501",
	});
});

it.each(lockFunctions)("denies $functionName execution through PUBLIC privileges", async ({ profileName, query }) => {
	await setup.query("BEGIN");
	await setup.query(`SET LOCAL ROLE ${outsiderRole}`);
	await expect(setup.query(query, profileName === "reception" ? [target.professionalId] : [])).rejects.toMatchObject({
		code: "42501",
	});
});

it.each(["changed", "unchanged"])("rejects %s specialty writes by the locking owner", async (kind) => {
	await setup.query("BEGIN");
	await setup.query(
		`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
		[actor.userId, actor.clinicId],
	);
	await setup.query("SET LOCAL ROLE medical_data_hub_locking_owner");
	expect(
		(
			await setup.query("SELECT professional_id FROM public.professionals WHERE professional_id = $1::uuid", [
				target.professionalId,
			])
		).rows,
	).toEqual([{ professional_id: target.professionalId }]);
	const query =
		kind === "changed"
			? "UPDATE public.professionals SET specialty_id = $2::uuid WHERE professional_id = $1::uuid"
			: "UPDATE public.professionals SET specialty_id = specialty_id WHERE professional_id = $1::uuid";
	const values = kind === "changed" ? [target.professionalId, otherSpecialtyId] : [target.professionalId];
	await expect(setup.query(query, values)).rejects.toMatchObject({
		code: "42501",
		message: 'new row violates row-level security policy for table "professionals"',
	});
});

it.each([
	["professional user link updates", "UPDATE public.professionals SET user_id = user_id WHERE false"],
	["professional clinic updates", "UPDATE public.professionals SET clinic_id = clinic_id WHERE false"],
	[
		"professional inserts",
		"INSERT INTO public.professionals (clinic_id, user_id, specialty_id) VALUES (NULL, NULL, NULL)",
	],
	["professional deletion", "DELETE FROM public.professionals WHERE false"],
	["professional truncation", "TRUNCATE public.professionals"],
	["professional service association reads", "SELECT is_active FROM public.professional_services"],
])("denies locking owner access to %s", async (_name, query) => {
	await setup.query("BEGIN");
	await setup.query("SET LOCAL ROLE medical_data_hub_locking_owner");
	await expect(setup.query(query)).rejects.toMatchObject({ code: "42501" });
});

it("limits locking owner professional grants to identifier reads and the specialty locking column", async () => {
	const { rows } = await setup.query(`
        SELECT attribute.attname,
            pg_catalog.has_column_privilege('medical_data_hub_locking_owner', attribute.attrelid, attribute.attnum, 'SELECT') AS can_select,
            pg_catalog.has_column_privilege('medical_data_hub_locking_owner', attribute.attrelid, attribute.attnum, 'UPDATE') AS can_update
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.professionals'::regclass AND attribute.attnum > 0 AND NOT attribute.attisdropped
        ORDER BY attribute.attname
    `);
	expect(rows).toEqual([
		{ attname: "clinic_id", can_select: true, can_update: false },
		{ attname: "professional_id", can_select: true, can_update: false },
		{ attname: "specialty_id", can_select: true, can_update: true },
		{ attname: "user_id", can_select: true, can_update: false },
	]);
});

it("uses the locking owner and trusted search path for both volatile professional functions", async () => {
	const names = lockFunctions.map((lock) => lock.functionName);
	const { rows } = await setup.query(
		`SELECT proname, pronargs, pg_catalog.pg_get_userbyid(proowner) AS owner, prosecdef, provolatile, proconfig
        FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = ANY($1::text[]) ORDER BY proname`,
		[names],
	);
	expect(rows).toEqual(
		[...lockFunctions]
			.sort((left, right) => left.functionName.localeCompare(right.functionName))
			.map((lock) => ({
				proname: lock.functionName,
				pronargs: lock.profileName === "reception" ? 1 : 0,
				owner: "medical_data_hub_locking_owner",
				prosecdef: true,
				provolatile: "v",
				proconfig: ["search_path=pg_catalog, pg_temp"],
			})),
	);
});

it("grants each professional locking function only to its operating profile besides the owner", async () => {
	const names = lockFunctions.map((lock) => lock.functionName);
	const { rows } = await setup.query(
		`SELECT function_definition.proname, pg_catalog.pg_get_userbyid(privilege.grantee) AS grantee,
            privilege.privilege_type, privilege.is_grantable
        FROM pg_catalog.pg_proc AS function_definition
        CROSS JOIN LATERAL pg_catalog.aclexplode(function_definition.proacl) AS privilege
        WHERE function_definition.pronamespace = 'public'::regnamespace AND function_definition.proname = ANY($1::text[])
            AND privilege.grantee <> function_definition.proowner
        ORDER BY function_definition.proname`,
		[names],
	);
	expect(rows).toEqual(
		[...lockFunctions]
			.sort((left, right) => left.functionName.localeCompare(right.functionName))
			.map((lock) => ({
				proname: lock.functionName,
				grantee: lock.profileName,
				privilege_type: "EXECUTE",
				is_grantable: false,
			})),
	);
});

it.each(lockFunctions)(
	"ignores a caller temporary professional table through $functionName",
	async ({ profileName, query }) => {
		const actorId = profileName === "reception" ? actor.userId : target.userId;
		await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actorId]);
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		await api.query(
			"CREATE TEMP TABLE professionals (professional_id uuid, clinic_id uuid, user_id uuid, specialty_id uuid) ON COMMIT DROP",
		);
		await api.query("INSERT INTO pg_temp.professionals VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)", [
			target.professionalId,
			target.clinicId,
			target.userId,
			randomUUID(),
		]);
		await api.query("GRANT SELECT ON pg_temp.professionals TO medical_data_hub_locking_owner");
		await api.query("GRANT UPDATE (specialty_id) ON pg_temp.professionals TO medical_data_hub_locking_owner");
		await api.query("SET LOCAL search_path = pg_temp, public");
		const { rows } = await api.query(query, profileName === "reception" ? [target.professionalId] : []);
		expect(rows).toEqual([
			{
				professional_id: target.professionalId,
				clinic_id: target.clinicId,
				user_id: target.userId,
				specialty_id: target.specialtyId,
			},
		]);
	},
);
