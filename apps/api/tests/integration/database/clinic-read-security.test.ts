import { Client, escapeIdentifier } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Clinic, User } from "../../../src/generated/prisma/client.js";

type ClinicMetadata = Pick<Clinic, "clinicId" | "timeZone">;
type ClinicActor = Pick<User, "userId" | "clinicId"> & { role: string };

const setupConnectionString = process.env.DATABASE_SETUP_URL;
const apiConnectionString = process.env.DATABASE_URL;
if(!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const api = new Client({ connectionString: apiConnectionString });
const profileNames = ["clinic_administrator", "reception", "healthcare_professional"];
let clinics: ClinicMetadata[];
let actors: ClinicActor[];

beforeAll(async () => {

	await setup.connect();
	await api.connect();
	const clinicResult = await setup.query<ClinicMetadata>(`
        SELECT clinic_id AS "clinicId", time_zone AS "timeZone" FROM public.clinics ORDER BY clinic_id
    `);
	clinics = clinicResult.rows;
	const actorResult = await setup.query<ClinicActor>(`
        SELECT user_id AS "userId", clinic_id AS "clinicId", role::text
        FROM public.users WHERE role IN ('clinic_administrator', 'reception', 'healthcare_professional')
        ORDER BY clinic_id, user_id
    `);
	actors = actorResult.rows;

});

afterAll(async () => {
	await api.end();
	await setup.end();
});

it("filters clinic reads when context settings have never been set", async () => {

	const fresh = new Client({ connectionString: apiConnectionString });
	await fresh.connect();
	try {

		await fresh.query("BEGIN");
		await fresh.query("SET LOCAL ROLE reception");
		const context = await fresh.query(`
            SELECT pg_catalog.current_setting('app.user_id', true) AS user_id,
                   pg_catalog.current_setting('app.clinic_id', true) AS clinic_id
        `);
		expect(context.rows).toEqual([{ user_id: null, clinic_id: null }]);
		const { rows } = await fresh.query("SELECT clinic_id, time_zone FROM public.clinics");
		expect(rows).toEqual([]);

	} finally {
		await fresh.query("ROLLBACK");
		await fresh.end();
	}

});

it("reads only the contextual clinic and allowed columns as reception", async () => {

	const profileName = "reception";
	const clinic = clinics[0];
	const actor = actors.find((user) => user.role === profileName && user.clinicId === clinic.clinicId)!;
	await api.query("BEGIN");
	try {

		await api.query(
			`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
			[actor.userId, clinic.clinicId],
		);
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		const result = await api.query("SELECT clinic_id, time_zone FROM public.clinics");
		expect(result.fields.map((field) => field.name)).toEqual(["clinic_id", "time_zone"]);
		expect(result.rows).toEqual([{ clinic_id: clinic.clinicId, time_zone: clinic.timeZone }]);

	} finally {
		await api.query("ROLLBACK");
	}

});

it("filters empty and NULL context fields as reception", async () => {

	const profileName = "reception";
	const clinic = clinics[0];
	const actor = actors.find((user) => user.role === profileName && user.clinicId === clinic.clinicId)!;
	for(const [userId, clinicId] of [
		["", clinic.clinicId],
		[actor.userId, ""],
		[null, clinic.clinicId],
		[actor.userId, null],
	]) {

		await api.query("BEGIN");
		try {

			await api.query(
				`SELECT pg_catalog.set_config('app.user_id', $1, true),
                pg_catalog.set_config('app.clinic_id', $2, true)`,
				[userId, clinicId],
			);
			await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
			const { rows } = await api.query("SELECT clinic_id, time_zone FROM public.clinics");
			expect(rows).toEqual([]);

		} finally {
			await api.query("ROLLBACK");
		}

	}

});

it("rejects malformed context UUIDs as reception", async () => {

	const profileName = "reception";
	const clinic = clinics[0];
	const actor = actors.find((user) => user.role === profileName && user.clinicId === clinic.clinicId)!;
	for(const [userId, clinicId] of [
		["not-a-uuid", clinic.clinicId],
		[actor.userId, "not-a-uuid"],
	]) {

		await api.query("BEGIN");
		try {

			await api.query(
				`SELECT pg_catalog.set_config('app.user_id', $1, true),
                pg_catalog.set_config('app.clinic_id', $2, true)`,
				[userId, clinicId],
			);
			await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
			await expect(api.query("SELECT clinic_id, time_zone FROM public.clinics")).rejects.toMatchObject({
				code: "22P02",
			});

		} finally {
			await api.query("ROLLBACK");
		}

	}

});

it("grants only the two clinic SELECT columns without table privileges or grant options", async () => {

	const columnGrants = await setup.query(
		`
        SELECT grantee, column_name, privilege_type, is_grantable FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = 'clinics' AND grantee = ANY($1::text[])
        ORDER BY grantee, column_name, privilege_type
    `,
		[profileNames],
	);
	expect(columnGrants.rows).toEqual(
		[...profileNames].sort().flatMap((grantee) => [
			{ grantee, column_name: "clinic_id", privilege_type: "SELECT", is_grantable: "NO" },
			{ grantee, column_name: "time_zone", privilege_type: "SELECT", is_grantable: "NO" },
		]),
	);
	const tableGrants = await setup.query(
		`
        SELECT grantee, privilege_type FROM information_schema.table_privileges
        WHERE table_schema = 'public' AND table_name = 'clinics' AND grantee = ANY($1::text[])
    `,
		[profileNames],
	);
	expect(tableGrants.rows).toEqual([]);

});

it("ends transaction-local clinic context after COMMIT", async () => {

	const boundary = "COMMIT";
	const clinic = clinics[0];
	const actor = actors.find((user) => user.role === "reception" && user.clinicId === clinic.clinicId)!;
	await api.query("BEGIN");
	try {

		await api.query(
			`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
			[actor.userId, clinic.clinicId],
		);
		await api.query("SET LOCAL ROLE reception");
		const first = await api.query("SELECT clinic_id, time_zone FROM public.clinics");
		expect(first.rows).toEqual([{ clinic_id: clinic.clinicId, time_zone: clinic.timeZone }]);
		await api.query(boundary);
		await api.query("BEGIN");
		await api.query("SET LOCAL ROLE reception");
		const next = await api.query("SELECT clinic_id, time_zone FROM public.clinics");
		expect(next.rows).toEqual([]);

	} finally {
		await api.query("ROLLBACK");
	}

});
