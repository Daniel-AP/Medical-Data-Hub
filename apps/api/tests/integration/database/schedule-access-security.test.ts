import { Client, escapeIdentifier } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type {
	Professional,
	ProfessionalBlock,
	ProfessionalSchedule,
	User,
} from "../../../src/generated/prisma/client.js";

type LocalUser = Pick<User, "userId" | "clinicId"> & { role: string };

const setupConnectionString = process.env.DATABASE_SETUP_URL;
const apiConnectionString = process.env.DATABASE_URL;
if (!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const api = new Client({ connectionString: apiConnectionString });
const profileNames = ["clinic_administrator", "reception", "healthcare_professional"];
const writerProfiles = ["clinic_administrator", "healthcare_professional"];
const tableNames = ["professional_schedules", "professional_blocks"] as const;
const readableTables = tableNames.flatMap((tableName) =>
	profileNames.map((profileName) => ({ tableName, profileName })),
);
const writableTables = tableNames.flatMap((tableName) =>
	writerProfiles.map((profileName) => ({ tableName, profileName })),
);
const invalidContexts = [
	{ field: "app.user_id", value: "", label: "an empty actor", malformed: false },
	{ field: "app.clinic_id", value: "", label: "an empty clinic", malformed: false },
	{ field: "app.user_id", value: null, label: "a reset actor", malformed: false },
	{ field: "app.clinic_id", value: null, label: "a reset clinic", malformed: false },
	{ field: "app.user_id", value: "not-a-uuid", label: "a malformed actor", malformed: true },
	{ field: "app.clinic_id", value: "not-a-uuid", label: "a malformed clinic", malformed: true },
];
const insertQueries = {
	professional_schedules:
		"INSERT INTO public.professional_schedules (clinic_id, professional_id, weekday, start_minute, end_minute) VALUES ($1::uuid, $2::uuid, 7, 1200, 1260)",
	professional_blocks:
		"INSERT INTO public.professional_blocks (clinic_id, professional_id, start_at, end_at) VALUES ($1::uuid, $2::uuid, '2030-01-06 20:00:00+00', '2030-01-06 21:00:00+00')",
};
let users: LocalUser[];
let administrator: LocalUser;
let professionalActor: LocalUser;
let localProfessional: Professional;
let otherProfessional: Professional;
let foreignProfessional: Professional;
let schedules: ProfessionalSchedule[];
let blocks: ProfessionalBlock[];
let localSchedule: ProfessionalSchedule;
let otherSchedule: ProfessionalSchedule;
let foreignSchedule: ProfessionalSchedule;

beforeAll(async () => {
	await setup.connect();
	await api.connect();
	const userResult = await setup.query<LocalUser>(`
        SELECT user_id AS "userId", clinic_id AS "clinicId", role::text
        FROM public.users ORDER BY clinic_id NULLS LAST, user_id
    `);
	users = userResult.rows;
	administrator = users.find((user) => user.role === "clinic_administrator")!;
	professionalActor = users.find(
		(user) => user.role === "healthcare_professional" && user.clinicId === administrator.clinicId,
	)!;
	const professionalResult = await setup.query<Professional>(`
        SELECT professional_id AS "professionalId", clinic_id AS "clinicId", user_id AS "userId", specialty_id AS "specialtyId"
        FROM public.professionals ORDER BY professional_id
    `);
	localProfessional = professionalResult.rows.find(
		(professional) => professional.userId === professionalActor.userId,
	)!;
	otherProfessional = professionalResult.rows.find(
		(professional) =>
			professional.clinicId === administrator.clinicId &&
			professional.professionalId !== localProfessional.professionalId,
	)!;
	foreignProfessional = professionalResult.rows.find(
		(professional) => professional.clinicId !== administrator.clinicId,
	)!;
	const scheduleResult = await setup.query<ProfessionalSchedule>(`
        SELECT professional_schedule_id AS "professionalScheduleId", clinic_id AS "clinicId", professional_id AS "professionalId",
            weekday, start_minute AS "startMinute", end_minute AS "endMinute"
        FROM public.professional_schedules ORDER BY professional_schedule_id
    `);
	const blockResult = await setup.query<ProfessionalBlock>(`
        SELECT professional_block_id AS "professionalBlockId", clinic_id AS "clinicId", professional_id AS "professionalId",
            start_at AS "startAt", end_at AS "endAt"
        FROM public.professional_blocks ORDER BY professional_block_id
    `);
	schedules = scheduleResult.rows;
	blocks = blockResult.rows;
	localSchedule = schedules.find((schedule) => schedule.professionalId === localProfessional.professionalId)!;
	otherSchedule = schedules.find((schedule) => schedule.professionalId === otherProfessional.professionalId)!;
	foreignSchedule = schedules.find((schedule) => schedule.professionalId === foreignProfessional.professionalId)!;
});

beforeEach(async () => {
	await api.query("BEGIN");
	await api.query(
		`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
		[administrator.userId, administrator.clinicId],
	);
	await api.query("SET LOCAL ROLE clinic_administrator");
});

afterEach(async () => {
	await api.query("ROLLBACK");
});

afterAll(async () => {
	await api.end();
	await setup.end();
});

it.each(readableTables)("reads all same-clinic $tableName rows as $profileName", async ({ tableName, profileName }) => {
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	if (tableName === "professional_schedules") {
		const { rows } = await api.query(
			`SELECT professional_schedule_id AS "professionalScheduleId", clinic_id AS "clinicId", professional_id AS "professionalId",
                weekday, start_minute AS "startMinute", end_minute AS "endMinute"
            FROM public.professional_schedules ORDER BY professional_schedule_id`,
		);
		expect(rows).toEqual(schedules.filter((schedule) => schedule.clinicId === actor.clinicId));
	} else {
		const { rows } = await api.query(
			`SELECT professional_block_id AS "professionalBlockId", clinic_id AS "clinicId", professional_id AS "professionalId",
                start_at AS "startAt", end_at AS "endAt"
            FROM public.professional_blocks ORDER BY professional_block_id`,
		);
		expect(rows).toEqual(blocks.filter((block) => block.clinicId === actor.clinicId));
	}
});

it.each(readableTables)("filters foreign $tableName rows as $profileName", async ({ tableName, profileName }) => {
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	const { rows } = await api.query(
		`SELECT * FROM public.${escapeIdentifier(tableName)} WHERE professional_id = $1::uuid`,
		[foreignProfessional.professionalId],
	);
	expect(rows).toEqual([]);
});

it.each(writerProfiles)("allows permitted schedule insertion, editing, and deletion as %s", async (profileName) => {
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	const target = profileName === "clinic_administrator" ? otherProfessional : localProfessional;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	const inserted = await api.query(insertQueries.professional_schedules + " RETURNING professional_schedule_id", [
		actor.clinicId,
		target.professionalId,
	]);
	const scheduleId = inserted.rows[0].professional_schedule_id;
	expect(scheduleId).toEqual(expect.any(String));
	const updated = await api.query(
		`UPDATE public.professional_schedules SET weekday = 6, start_minute = 600, end_minute = 660
        WHERE professional_schedule_id = $1::uuid
        RETURNING professional_schedule_id, clinic_id, professional_id, weekday, start_minute, end_minute`,
		[scheduleId],
	);
	expect(updated.rows).toEqual([
		{
			professional_schedule_id: scheduleId,
			clinic_id: actor.clinicId,
			professional_id: target.professionalId,
			weekday: 6,
			start_minute: 600,
			end_minute: 660,
		},
	]);
	const deleted = await api.query(
		"DELETE FROM public.professional_schedules WHERE professional_schedule_id = $1::uuid",
		[scheduleId],
	);
	expect(deleted.rowCount).toBe(1);
});

it.each(writerProfiles)("allows permitted block insertion as %s", async (profileName) => {
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	const target = profileName === "clinic_administrator" ? otherProfessional : localProfessional;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	const { rows } = await api.query(
		insertQueries.professional_blocks +
			" RETURNING professional_block_id, clinic_id, professional_id, start_at, end_at",
		[actor.clinicId, target.professionalId],
	);
	expect(rows).toEqual([
		{
			professional_block_id: expect.any(String),
			clinic_id: actor.clinicId,
			professional_id: target.professionalId,
			start_at: new Date("2030-01-06T20:00:00.000Z"),
			end_at: new Date("2030-01-06T21:00:00.000Z"),
		},
	]);
});

it.each(tableNames)(
	"rejects another local professional's %s insertion by healthcare professionals",
	async (tableName) => {
		await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [professionalActor.userId]);
		await api.query("SET LOCAL ROLE healthcare_professional");
		await expect(
			api.query(insertQueries[tableName], [administrator.clinicId, otherProfessional.professionalId]),
		).rejects.toMatchObject({
			code: "42501",
			message: `new row violates row-level security policy for table "${tableName}"`,
		});
	},
);

it.each(["UPDATE", "DELETE"])("filters another local professional's schedule %s", async (operation) => {
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [professionalActor.userId]);
	await api.query("SET LOCAL ROLE healthcare_professional");
	const query =
		operation === "UPDATE"
			? "UPDATE public.professional_schedules SET weekday = weekday WHERE professional_schedule_id = $1::uuid"
			: "DELETE FROM public.professional_schedules WHERE professional_schedule_id = $1::uuid";
	const result = await api.query(query, [otherSchedule.professionalScheduleId]);
	expect(result.rowCount).toBe(0);
});

it.each(tableNames)("rejects own %s inserts without an associated professional profile", async (tableName) => {
	await api.query("SET LOCAL ROLE healthcare_professional");
	await expect(
		api.query(insertQueries[tableName], [administrator.clinicId, localProfessional.professionalId]),
	).rejects.toMatchObject({
		code: "42501",
		message: `new row violates row-level security policy for table "${tableName}"`,
	});
});

it.each(writableTables)(
	"rejects foreign-clinic $tableName inserts as $profileName",
	async ({ tableName, profileName }) => {
		const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
		await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		await expect(
			api.query(insertQueries[tableName], [foreignProfessional.clinicId, foreignProfessional.professionalId]),
		).rejects.toMatchObject({
			code: "42501",
			message: `new row violates row-level security policy for table "${tableName}"`,
		});
	},
);

it.each(tableNames)("preserves same-clinic professional references in administrative %s inserts", async (tableName) => {
	await expect(
		api.query(insertQueries[tableName], [administrator.clinicId, foreignProfessional.professionalId]),
	).rejects.toMatchObject({ code: "23503", constraint: `${tableName}_clinic_id_professional_id_fkey` });
});

it.each(tableNames)("rejects hidden foreign professional references in own %s inserts", async (tableName) => {
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [professionalActor.userId]);
	await api.query("SET LOCAL ROLE healthcare_professional");
	await expect(
		api.query(insertQueries[tableName], [administrator.clinicId, foreignProfessional.professionalId]),
	).rejects.toMatchObject({
		code: "42501",
		message: `new row violates row-level security policy for table "${tableName}"`,
	});
});

it.each(writerProfiles.flatMap((profileName) => ["UPDATE", "DELETE"].map((operation) => ({ profileName, operation }))))(
	"filters foreign schedule $operation as $profileName",
	async ({ profileName, operation }) => {
		const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
		await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		const query =
			operation === "UPDATE"
				? "UPDATE public.professional_schedules SET weekday = weekday WHERE professional_schedule_id = $1::uuid"
				: "DELETE FROM public.professional_schedules WHERE professional_schedule_id = $1::uuid";
		expect((await api.query(query, [foreignSchedule.professionalScheduleId])).rowCount).toBe(0);
	},
);

it.each(
	writerProfiles.flatMap((profileName) =>
		["professional_schedule_id", "clinic_id", "professional_id"].map((columnName) => ({ profileName, columnName })),
	),
)("denies schedule $columnName updates to $profileName", async ({ profileName, columnName }) => {
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	const column = escapeIdentifier(columnName);
	await expect(
		api.query(
			`UPDATE public.professional_schedules SET ${column} = ${column} WHERE professional_schedule_id = $1::uuid`,
			[localSchedule.professionalScheduleId],
		),
	).rejects.toMatchObject({ code: "42501" });
});

const deniedReceptionOperations = [
	{ operation: "schedule INSERT", query: insertQueries.professional_schedules, inserts: true },
	{
		operation: "schedule UPDATE",
		query: "UPDATE public.professional_schedules SET weekday = weekday WHERE professional_id = $1::uuid",
		inserts: false,
	},
	{
		operation: "schedule DELETE",
		query: "DELETE FROM public.professional_schedules WHERE professional_id = $1::uuid",
		inserts: false,
	},
	{ operation: "block INSERT", query: insertQueries.professional_blocks, inserts: true },
];

it.each(deniedReceptionOperations)("denies $operation to reception", async ({ query, inserts }) => {
	const actor = users.find((user) => user.role === "reception" && user.clinicId === administrator.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query("SET LOCAL ROLE reception");
	const values = inserts ? [actor.clinicId, localProfessional.professionalId] : [localProfessional.professionalId];
	await expect(api.query(query, values)).rejects.toMatchObject({ code: "42501" });
});

it.each(profileNames.flatMap((profileName) => ["UPDATE", "DELETE"].map((operation) => ({ profileName, operation }))))(
	"denies block $operation to $profileName",
	async ({ profileName, operation }) => {
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		const query =
			operation === "UPDATE"
				? "UPDATE public.professional_blocks SET start_at = start_at WHERE professional_id = $1::uuid"
				: "DELETE FROM public.professional_blocks WHERE professional_id = $1::uuid";
		await expect(api.query(query, [localProfessional.professionalId])).rejects.toMatchObject({ code: "42501" });
	},
);

it.each(readableTables)("denies $tableName truncation to $profileName", async ({ tableName, profileName }) => {
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	await expect(api.query(`TRUNCATE public.${escapeIdentifier(tableName)}`)).rejects.toMatchObject({ code: "42501" });
});

it.each(
	tableNames.flatMap((tableName) =>
		[
			"medical_data_hub_api",
			"platform_administrator",
			"medical_data_hub_identity_owner",
			"medical_data_hub_metadata_owner",
			"medical_data_hub_locking_owner",
		].map((profileName) => ({ tableName, profileName })),
	),
)("denies ordinary $tableName reads to $profileName", async ({ tableName, profileName }) => {
	await setup.query("BEGIN");
	try {
		await setup.query(
			`SELECT pg_catalog.set_config('app.user_id', $1, true),
                    pg_catalog.set_config('app.clinic_id', $2, true)`,
			[administrator.userId, administrator.clinicId],
		);
		await setup.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		await expect(setup.query(`SELECT * FROM public.${escapeIdentifier(tableName)}`)).rejects.toMatchObject({
			code: "42501",
		});
	} finally {
		await setup.query("ROLLBACK");
	}
});

it.each(readableTables.flatMap((access) => invalidContexts.map((context) => ({ ...access, ...context }))))(
	"restricts $tableName reads with $label as $profileName",
	async ({ tableName, profileName, field, value, malformed }) => {
		const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
		await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
		await api.query("SELECT pg_catalog.set_config($1, $2, true)", [field, value]);
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		const result = api.query(`SELECT * FROM public.${escapeIdentifier(tableName)}`);
		if (malformed) {
			await expect(result).rejects.toMatchObject({ code: "22P02" });
		} else {
			expect((await result).rows).toEqual([]);
		}
	},
);

it.each(writableTables.flatMap((access) => invalidContexts.map((context) => ({ ...access, ...context }))))(
	"rejects $tableName inserts with $label as $profileName",
	async ({ tableName, profileName, field, value, malformed }) => {
		const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
		await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
		await api.query("SELECT pg_catalog.set_config($1, $2, true)", [field, value]);
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		const expected = malformed
			? { code: "22P02" }
			: { code: "42501", message: `new row violates row-level security policy for table "${tableName}"` };
		await expect(
			api.query(insertQueries[tableName], [administrator.clinicId, localProfessional.professionalId]),
		).rejects.toMatchObject(expected);
	},
);

const scheduleChanges = writerProfiles.flatMap((profileName) =>
	["UPDATE", "DELETE"].flatMap((operation) =>
		invalidContexts.map((context) => ({ profileName, operation, ...context })),
	),
);

it.each(scheduleChanges)(
	"restricts schedule $operation with $label as $profileName",
	async ({ profileName, operation, field, value, malformed }) => {
		const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
		await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
		await api.query("SELECT pg_catalog.set_config($1, $2, true)", [field, value]);
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		const query =
			operation === "UPDATE"
				? "UPDATE public.professional_schedules SET weekday = weekday WHERE professional_schedule_id = $1::uuid"
				: "DELETE FROM public.professional_schedules WHERE professional_schedule_id = $1::uuid";
		const result = api.query(query, [localSchedule.professionalScheduleId]);
		if (malformed) {
			await expect(result).rejects.toMatchObject({ code: "22P02" });
		} else {
			expect((await result).rowCount).toBe(0);
		}
	},
);

it.each(writerProfiles)("denies schedule and block access without context as %s", async (profileName) => {
	const fresh = new Client({ connectionString: apiConnectionString });
	await fresh.connect();
	try {
		await fresh.query("BEGIN");
		await fresh.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		for (const tableName of tableNames) {
			expect((await fresh.query(`SELECT * FROM public.${escapeIdentifier(tableName)}`)).rows).toEqual([]);
			await fresh.query("SAVEPOINT denied_insert");
			await expect(
				fresh.query(insertQueries[tableName], [administrator.clinicId, localProfessional.professionalId]),
			).rejects.toMatchObject({
				code: "42501",
				message: `new row violates row-level security policy for table "${tableName}"`,
			});
			await fresh.query("ROLLBACK TO SAVEPOINT denied_insert");
		}
		const updated = await fresh.query(
			"UPDATE public.professional_schedules SET weekday = weekday WHERE professional_schedule_id = $1::uuid",
			[localSchedule.professionalScheduleId],
		);
		const deleted = await fresh.query(
			"DELETE FROM public.professional_schedules WHERE professional_schedule_id = $1::uuid",
			[localSchedule.professionalScheduleId],
		);
		expect(updated.rowCount).toBe(0);
		expect(deleted.rowCount).toBe(0);
	} finally {
		await fresh.query("ROLLBACK");
		await fresh.end();
	}
});

it("grants only the designed schedule and block table and column privileges", async () => {
	const roles = [
		"medical_data_hub_api",
		"platform_administrator",
		...profileNames,
		"medical_data_hub_identity_owner",
		"medical_data_hub_metadata_owner",
		"medical_data_hub_locking_owner",
	];
	const tableGrants = await setup.query(
		`SELECT table_name, grantee, privilege_type, is_grantable FROM information_schema.table_privileges
        WHERE table_schema = 'public' AND table_name = ANY($1::text[]) AND grantee = ANY($2::text[])
        ORDER BY table_name, grantee, privilege_type`,
		[tableNames, roles],
	);
	expect(tableGrants.rows).toEqual([
		{
			table_name: "professional_blocks",
			grantee: "clinic_administrator",
			privilege_type: "INSERT",
			is_grantable: "NO",
		},
		{
			table_name: "professional_blocks",
			grantee: "clinic_administrator",
			privilege_type: "SELECT",
			is_grantable: "NO",
		},
		{
			table_name: "professional_blocks",
			grantee: "healthcare_professional",
			privilege_type: "INSERT",
			is_grantable: "NO",
		},
		{
			table_name: "professional_blocks",
			grantee: "healthcare_professional",
			privilege_type: "SELECT",
			is_grantable: "NO",
		},
		{ table_name: "professional_blocks", grantee: "reception", privilege_type: "SELECT", is_grantable: "NO" },
		{
			table_name: "professional_schedules",
			grantee: "clinic_administrator",
			privilege_type: "DELETE",
			is_grantable: "NO",
		},
		{
			table_name: "professional_schedules",
			grantee: "clinic_administrator",
			privilege_type: "INSERT",
			is_grantable: "NO",
		},
		{
			table_name: "professional_schedules",
			grantee: "clinic_administrator",
			privilege_type: "SELECT",
			is_grantable: "NO",
		},
		{
			table_name: "professional_schedules",
			grantee: "healthcare_professional",
			privilege_type: "DELETE",
			is_grantable: "NO",
		},
		{
			table_name: "professional_schedules",
			grantee: "healthcare_professional",
			privilege_type: "INSERT",
			is_grantable: "NO",
		},
		{
			table_name: "professional_schedules",
			grantee: "healthcare_professional",
			privilege_type: "SELECT",
			is_grantable: "NO",
		},
		{ table_name: "professional_schedules", grantee: "reception", privilege_type: "SELECT", is_grantable: "NO" },
	]);
	const updateGrants = await setup.query(
		`SELECT table_name, grantee, column_name, is_grantable FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = ANY($1::text[]) AND grantee = ANY($2::text[]) AND privilege_type = 'UPDATE'
        ORDER BY table_name, grantee, column_name`,
		[tableNames, roles],
	);
	expect(updateGrants.rows).toEqual(
		writerProfiles.flatMap((grantee) =>
			["end_minute", "start_minute", "weekday"].map((columnName) => ({
				table_name: "professional_schedules",
				grantee,
				column_name: columnName,
				is_grantable: "NO",
			})),
		),
	);
});
