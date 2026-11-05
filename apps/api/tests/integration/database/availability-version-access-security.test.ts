import { Client, escapeIdentifier } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { ClinicAvailabilityVersion, User } from "../../../src/generated/prisma/client.js";

type VersionRow = Pick<ClinicAvailabilityVersion, "clinicId"> & { version: string };
type LocalUser = Pick<User, "userId" | "clinicId"> & { role: string };

const setupConnectionString = process.env.DATABASE_SETUP_URL;
const apiConnectionString = process.env.DATABASE_URL;
if (!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const api = new Client({ connectionString: apiConnectionString });
const clinicProfiles = ["clinic_administrator", "reception", "healthcare_professional"];
const excludedProfiles = ["medical_data_hub_api", "platform_administrator"];
const readQuery = 'SELECT clinic_id AS "clinicId", version FROM public.clinic_availability_versions';
const updateQuery = "UPDATE public.clinic_availability_versions SET version = version + 1";
const returning = ' RETURNING clinic_id AS "clinicId", version';
const operations = [
	{ operation: "SELECT", query: readQuery },
	{ operation: "UPDATE", query: updateQuery + returning },
];
const invalidContexts = [
	{ field: "app.user_id", value: "", label: "an empty actor", malformed: false },
	{ field: "app.clinic_id", value: "", label: "an empty clinic", malformed: false },
	{ field: "app.user_id", value: null, label: "a reset actor", malformed: false },
	{ field: "app.clinic_id", value: null, label: "a reset clinic", malformed: false },
	{ field: "app.user_id", value: "not-a-uuid", label: "a malformed actor", malformed: true },
	{ field: "app.clinic_id", value: "not-a-uuid", label: "a malformed clinic", malformed: true },
];

let localVersion: VersionRow;
let foreignVersion: VersionRow;
let users: LocalUser[];

beforeAll(async () => {
	await setup.connect();
	await api.connect();
	const { rows } = await setup.query<VersionRow>(readQuery + " ORDER BY clinic_id");
	[localVersion, foreignVersion] = rows;
	const userResult = await setup.query<LocalUser>(
		'SELECT user_id AS "userId", clinic_id AS "clinicId", role::text FROM public.users WHERE clinic_id = $1::uuid',
		[localVersion.clinicId],
	);
	users = userResult.rows;
});

beforeEach(async () => {
	await api.query("BEGIN");
});

afterEach(async () => {
	await api.query("ROLLBACK");
});

afterAll(async () => {
	await api.end();
	await setup.end();
});

async function setLocalProfile(profileName: string) {
	const actor = users.find((user) => user.role === profileName)!;
	await api.query(
		"SELECT pg_catalog.set_config('app.user_id', $1, true), pg_catalog.set_config('app.clinic_id', $2, true)",
		[actor.userId, actor.clinicId],
	);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
}

it("filters availability reads and updates on a connection without context settings", async () => {
	const fresh = new Client({ connectionString: apiConnectionString });
	await fresh.connect();
	try {
		await fresh.query("BEGIN");
		await fresh.query("SET LOCAL ROLE reception");
		expect((await fresh.query(readQuery)).rows).toEqual([]);
		expect((await fresh.query(updateQuery + returning)).rows).toEqual([]);
	} finally {
		await fresh.query("ROLLBACK");
		await fresh.end();
	}
});

it.each(clinicProfiles)("reads only the context clinic's availability version as %s", async (profileName) => {
	await setLocalProfile(profileName);
	expect((await api.query(readQuery)).rows).toEqual([localVersion]);
});

it.each(clinicProfiles)("increments only the context clinic's availability version as %s", async (profileName) => {
	await setLocalProfile(profileName);
	const { rows } = await api.query(updateQuery + returning);
	expect(rows).toEqual([{ ...localVersion, version: (BigInt(localVersion.version) + 1n).toString() }]);

	await api.query("ROLLBACK");
	expect((await setup.query(readQuery + " WHERE clinic_id = $1::uuid", [localVersion.clinicId])).rows).toEqual([
		localVersion,
	]);
});

it.each(clinicProfiles)("filters explicit foreign availability reads and updates as %s", async (profileName) => {
	await setLocalProfile(profileName);
	const foreignFilter = " WHERE clinic_id = $1::uuid";
	expect((await api.query(readQuery + foreignFilter, [foreignVersion.clinicId])).rows).toEqual([]);
	expect((await api.query(updateQuery + foreignFilter + returning, [foreignVersion.clinicId])).rows).toEqual([]);
});

it.each(operations.flatMap((operation) => invalidContexts.map((context) => ({ ...operation, ...context }))))(
	"restricts availability version $operation with $label",
	async ({ query, field, value, malformed }) => {
		await setLocalProfile("reception");
		await api.query("SELECT pg_catalog.set_config($1, $2, true)", [field, value]);
		const result = api.query(query);
		if (malformed) {
			await expect(result).rejects.toMatchObject({ code: "22P02" });
		} else {
			expect((await result).rows).toEqual([]);
		}
	},
);

it.each(clinicProfiles)("rejects a negative availability version as %s", async (profileName) => {
	await setLocalProfile(profileName);
	await expect(api.query("UPDATE public.clinic_availability_versions SET version = -1")).rejects.toMatchObject({
		code: "23514",
		constraint: "clinic_availability_versions_version_check",
	});
});

const deniedMutations = [
	{
		operation: "INSERT",
		query: "INSERT INTO public.clinic_availability_versions (clinic_id) VALUES (pg_catalog.gen_random_uuid())",
	},
	{ operation: "clinic_id UPDATE", query: "UPDATE public.clinic_availability_versions SET clinic_id = clinic_id" },
	{ operation: "DELETE", query: "DELETE FROM public.clinic_availability_versions" },
	{ operation: "TRUNCATE", query: "TRUNCATE public.clinic_availability_versions" },
];

it.each(clinicProfiles.flatMap((profileName) => deniedMutations.map((mutation) => ({ profileName, ...mutation }))))(
	"denies availability version $operation to $profileName",
	async ({ profileName, query }) => {
		await setLocalProfile(profileName);
		await expect(api.query(query)).rejects.toMatchObject({ code: "42501" });
	},
);

it.each(excludedProfiles.flatMap((profileName) => operations.map((operation) => ({ profileName, ...operation }))))(
	"denies availability version $operation to $profileName despite supplied context",
	async ({ profileName, query }) => {
		await setLocalProfile("reception");
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		await expect(api.query(query)).rejects.toMatchObject({ code: "42501" });
	},
);

it("grants availability version reads and only version column updates to clinic profiles", async () => {
	const roles = [
		...clinicProfiles,
		...excludedProfiles,
		"medical_data_hub_identity_owner",
		"medical_data_hub_metadata_owner",
		"medical_data_hub_locking_owner",
		"PUBLIC",
	];
	const tableGrants = await setup.query(
		`SELECT grantee, privilege_type, is_grantable FROM information_schema.table_privileges
        WHERE table_schema = 'public' AND table_name = 'clinic_availability_versions' AND grantee = ANY($1::text[])
        ORDER BY grantee, privilege_type`,
		[roles],
	);
	expect(tableGrants.rows).toEqual(
		clinicProfiles.toSorted().map((grantee) => ({ grantee, privilege_type: "SELECT", is_grantable: "NO" })),
	);
	const updateGrants = await setup.query(
		`SELECT grantee, column_name, is_grantable FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = 'clinic_availability_versions'
            AND grantee = ANY($1::text[]) AND privilege_type = 'UPDATE'
        ORDER BY grantee, column_name`,
		[roles],
	);
	expect(updateGrants.rows).toEqual(
		clinicProfiles.toSorted().map((grantee) => ({ grantee, column_name: "version", is_grantable: "NO" })),
	);
});
