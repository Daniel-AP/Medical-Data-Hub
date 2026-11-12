import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { User } from "../../../src/generated/prisma/client.js";

type LocalUser = Pick<User, "userId" | "clinicId" | "isActive"> & { role: string };

const setupConnectionString = process.env.DATABASE_SETUP_URL;
if(!setupConnectionString) {
	throw new Error("DATABASE_SETUP_URL is required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
let target: LocalUser;

beforeAll(async () => {

	await setup.connect();
	const { rows: [actor] } = await setup.query<LocalUser>(`
        SELECT user_id AS "userId", clinic_id AS "clinicId", role::text, is_active AS "isActive"
        FROM public.users WHERE role = 'reception' ORDER BY clinic_id, user_id LIMIT 1
    `);
	const targetResult = await setup.query<LocalUser>(
		`
        SELECT user_id AS "userId", clinic_id AS "clinicId", role::text, is_active AS "isActive"
        FROM public.users WHERE clinic_id = $1::uuid AND role = 'healthcare_professional' ORDER BY user_id LIMIT 1
    `,
		[actor.clinicId],
	);
	target = targetResult.rows[0];

});

afterAll(async () => {
	await setup.end();
});

it("rejects an actual activity update by the locking owner through RLS", async () => {

	await setup.query("BEGIN");
	try {

		await setup.query("SET LOCAL ROLE medical_data_hub_locking_owner");
		const visible = await setup.query("SELECT user_id FROM public.users WHERE user_id = $1::uuid", [target.userId]);
		expect(visible.rows).toEqual([{ user_id: target.userId }]);
		await expect(
			setup.query("UPDATE public.users SET is_active = false WHERE user_id = $1::uuid", [target.userId]),
		).rejects.toMatchObject({
			code: "42501",
			message: 'new row violates row-level security policy for table "users"',
		});

	} finally {
		await setup.query("ROLLBACK");
	}

});
