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
if(!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const api = new Client({ connectionString: apiConnectionString });
const profileNames = ["clinic_administrator", "reception", "healthcare_professional"];
const writerProfiles = ["clinic_administrator", "healthcare_professional"];
const tableNames = ["professional_schedules", "professional_blocks"] as const;
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
let schedules: ProfessionalSchedule[];
let blocks: ProfessionalBlock[];
let otherSchedule: ProfessionalSchedule;

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
	otherSchedule = schedules.find((schedule) => schedule.professionalId === otherProfessional.professionalId)!;

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

it.each([
	{ tableName: "professional_schedules", profileName: "reception" },
	{ tableName: "professional_blocks", profileName: "reception" },
] as const)("reads all same-clinic $tableName rows as $profileName", async ({ tableName, profileName }) => {

	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	if(tableName === "professional_schedules") {

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

it("allows permitted schedule insertion, editing, and deletion as healthcare_professional", async () => {

	const profileName = "healthcare_professional";
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	const target = localProfessional;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	const inserted = await api.query(insertQueries.professional_schedules+" RETURNING professional_schedule_id", [
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

it("allows permitted block insertion as healthcare_professional", async () => {

	const profileName = "healthcare_professional";
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	const target = localProfessional;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	const { rows } = await api.query(
		insertQueries.professional_blocks+
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

it("filters another local professional's schedule UPDATE", async () => {

	const operation = "UPDATE";
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [professionalActor.userId]);
	await api.query("SET LOCAL ROLE healthcare_professional");
	const query =
		operation === "UPDATE"
			? "UPDATE public.professional_schedules SET weekday = weekday WHERE professional_schedule_id = $1::uuid"
			: "DELETE FROM public.professional_schedules WHERE professional_schedule_id = $1::uuid";
	const result = await api.query(query, [otherSchedule.professionalScheduleId]);
	expect(result.rowCount).toBe(0);

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
