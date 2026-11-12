import { Client } from "pg";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import type { Service, User } from "../../../src/generated/prisma/client.js";

const setupConnectionString = process.env.DATABASE_SETUP_URL;
if(!setupConnectionString) {
	throw new Error("DATABASE_SETUP_URL is required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
let actor: Pick<User, "userId" | "clinicId">;
let target: Service;

beforeAll(async () => {

	await setup.connect();
	const actors = await setup.query<Pick<User, "userId" | "clinicId">>(`
        SELECT user_id AS "userId", clinic_id AS "clinicId"
        FROM public.users WHERE role = 'reception' ORDER BY clinic_id, user_id LIMIT 1
    `);
	actor = actors.rows[0];
	const services = await setup.query<Service>(`
        SELECT service_id AS "serviceId", clinic_id AS "clinicId", name, duration_minutes AS "durationMinutes",
            specialty_id AS "specialtyId", is_active AS "isActive"
        FROM public.services ORDER BY service_id
    `);
	target = services.rows.find((service) => service.clinicId === actor.clinicId)!;

});

afterEach(async () => {
	await setup.query("ROLLBACK");
});

afterAll(async () => {
	await setup.end();
});

it("rejects locking owner service writes using is_active = false", async () => {

	await setup.query("BEGIN");
	await setup.query(
		`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
		[actor.userId, actor.clinicId],
	);
	await setup.query("SET LOCAL ROLE medical_data_hub_locking_owner");
	expect(
		(await setup.query("SELECT service_id FROM public.services WHERE service_id = $1::uuid", [target.serviceId]))
			.rows,
	).toEqual([{ service_id: target.serviceId }]);
	await expect(
		setup.query("UPDATE public.services SET is_active = false WHERE service_id = $1::uuid", [target.serviceId]),
	).rejects.toMatchObject({
		code: "42501",
		message: 'new row violates row-level security policy for table "services"',
	});

});
