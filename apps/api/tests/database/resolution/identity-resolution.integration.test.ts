import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { User } from "../../../src/generated/prisma/client.js";

type LocalIdentity = Pick<User, "identityId" | "userId" | "clinicId">;

const setupConnectionString = process.env.DATABASE_SETUP_URL;
const apiConnectionString = process.env.DATABASE_URL;
if(!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const api = new Client({ connectionString: apiConnectionString });
let reception: LocalIdentity;

beforeAll(async () => {

	await setup.connect();
	await api.connect();
	const receptionResult = await setup.query<LocalIdentity>(`
        SELECT identity_id AS "identityId", user_id AS "userId", clinic_id AS "clinicId"
        FROM public.users WHERE role = 'reception' ORDER BY user_id LIMIT 1
    `);
	reception = receptionResult.rows[0];

});

afterAll(async () => {
	await api.end();
	await setup.end();
});

it("ignores a caller temporary table and search path during identity resolution", async () => {

	await api.query("BEGIN");
	try {

		await api.query("CREATE TEMP TABLE users (identity_id text, user_id uuid, clinic_id uuid) ON COMMIT DROP");
		await api.query("INSERT INTO pg_temp.users (identity_id, user_id, clinic_id) VALUES ($1, $2::uuid, $3::uuid)", [
			reception.identityId,
			randomUUID(),
			randomUUID(),
		]);
		await api.query("GRANT SELECT ON pg_temp.users TO medical_data_hub_identity_owner");
		await api.query("SET LOCAL search_path = pg_temp, public");
		const { rows } = await api.query("SELECT * FROM public.resolve_identity($1::text)", [reception.identityId]);
		expect(rows).toEqual([{ user_id: reception.userId, clinic_id: reception.clinicId }]);

	} finally {
		await api.query("ROLLBACK");
	}

});
