import { Client, escapeIdentifier } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { ClinicAvailabilityVersion, User } from "../../../src/generated/prisma/client.js";

type VersionRow = Pick<ClinicAvailabilityVersion, "clinicId"> & { version: string };
type LocalUser = Pick<User, "userId" | "clinicId"> & { role: string };

const setupConnectionString = process.env.DATABASE_SETUP_URL;
const apiConnectionString = process.env.DATABASE_URL;
if(!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const api = new Client({ connectionString: apiConnectionString });
const readQuery = 'SELECT clinic_id AS "clinicId", version FROM public.clinic_availability_versions';
const updateQuery = "UPDATE public.clinic_availability_versions SET version = version + 1";
const returning = ' RETURNING clinic_id AS "clinicId", version';

let localVersion: VersionRow;
let foreignVersion: VersionRow;
let users: LocalUser[];

beforeAll(async () => {

	await setup.connect();
	await api.connect();
	const { rows } = await setup.query<VersionRow>(readQuery+" ORDER BY clinic_id");
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

const setLocalProfile = async (profileName: string) => {

	const actor = users.find((user) => user.role === profileName)!;
	await api.query(
		"SELECT pg_catalog.set_config('app.user_id', $1, true), pg_catalog.set_config('app.clinic_id', $2, true)",
		[actor.userId, actor.clinicId],
	);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);

};

it("filters explicit foreign availability reads and updates as reception", async () => {

	const profileName = "reception";
	await setLocalProfile(profileName);
	const foreignFilter = " WHERE clinic_id = $1::uuid";
	expect((await api.query(readQuery+foreignFilter, [foreignVersion.clinicId])).rows).toEqual([]);
	expect((await api.query(updateQuery+foreignFilter+returning, [foreignVersion.clinicId])).rows).toEqual([]);

});
