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
let actor: Pick<User, "userId" | "clinicId">;
let target: Professional;
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
	target = professionals.rows.find((professional) => professional.clinicId === actor.clinicId)!;
	foreignProfessional = professionals.rows.find((professional) => professional.clinicId !== actor.clinicId)!;
	const specialty = await setup.query(
		"SELECT specialty_id FROM public.specialties WHERE clinic_id = $1::uuid AND specialty_id <> $2::uuid ORDER BY specialty_id LIMIT 1",
		[target.clinicId, target.specialtyId],
	);
	otherSpecialtyId = specialty.rows[0].specialty_id;
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

it("filters and does not lock another clinic's professional", async () => {
	expect((await api.query(lockFunctions[0].query, [foreignProfessional.professionalId])).rows).toEqual([]);
	await setup.query("BEGIN");
	const unlocked = await setup.query(
		"SELECT professional_id FROM public.professionals WHERE professional_id = $1::uuid FOR UPDATE NOWAIT",
		[foreignProfessional.professionalId],
	);
	expect(unlocked.rows).toEqual([{ professional_id: foreignProfessional.professionalId }]);
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

it("rejects changed specialty writes by the locking owner", async () => {
	const kind = "changed";
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
