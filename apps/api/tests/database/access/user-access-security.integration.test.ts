import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { User } from "../../../src/generated/prisma/client.js";

type LocalUser = Pick<User, "userId" | "identityId" | "clinicId" | "isActive"> & { role: string };

const setupConnectionString = process.env.DATABASE_SETUP_URL;
const apiConnectionString = process.env.DATABASE_URL;
if(!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const api = new Client({ connectionString: apiConnectionString });
let users: LocalUser[];
let administrator: LocalUser;
let otherAdministrator: LocalUser;
let foreignTarget: LocalUser;

beforeAll(async () => {

	await setup.connect();
	await api.connect();
	const result = await setup.query<LocalUser>(`
        SELECT user_id AS "userId", identity_id AS "identityId", clinic_id AS "clinicId", role::text, is_active AS "isActive"
        FROM public.users ORDER BY clinic_id NULLS LAST, user_id
    `);
	users = result.rows;
	administrator = users.find((user) => user.role === "clinic_administrator")!;
	otherAdministrator = users.find(
		(user) => user.role === "clinic_administrator" && user.clinicId !== administrator.clinicId,
	)!;
	foreignTarget = users.find(
		(user) => user.role === "healthcare_professional" && user.clinicId === otherAdministrator.clinicId,
	)!;

});

afterAll(async () => {
	await api.end();
	await setup.end();
});

it("filters administrative user updates targeting another clinic", async () => {

	await api.query("BEGIN");
	try {

		await api.query(
			`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
			[administrator.userId, administrator.clinicId],
		);
		await api.query("SET LOCAL ROLE clinic_administrator");
		const result = await api.query(
			"UPDATE public.users SET is_active = false WHERE user_id = $1::uuid RETURNING user_id",
			[foreignTarget.userId],
		);
		expect(result.rowCount).toBe(0);
		expect(result.rows).toEqual([]);

	} finally {
		await api.query("ROLLBACK");
	}

});

it("rejects user inserts into another clinic through RLS", async () => {

	await api.query("BEGIN");
	try {

		await api.query(
			`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
			[administrator.userId, administrator.clinicId],
		);
		await api.query("SET LOCAL ROLE clinic_administrator");
		await expect(
			api.query("INSERT INTO public.users (identity_id, clinic_id, role) VALUES ($1, $2::uuid, 'reception')", [
				administrator.identityId,
				otherAdministrator.clinicId,
			]),
		).rejects.toMatchObject({
			code: "42501",
			message: 'new row violates row-level security policy for table "users"',
		});

	} finally {
		await api.query("ROLLBACK");
	}

});
