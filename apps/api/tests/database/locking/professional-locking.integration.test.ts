import { Client } from "pg";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import type { Professional, User } from "../../../src/generated/prisma/client.js";

const setupConnectionString = process.env.DATABASE_SETUP_URL;
if(!setupConnectionString) {
	throw new Error("DATABASE_SETUP_URL is required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
let actor: Pick<User, "userId" | "clinicId">;
let target: Professional;
let otherSpecialtyId: string;

beforeAll(async () => {

	await setup.connect();
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
	const specialty = await setup.query(
		"SELECT specialty_id FROM public.specialties WHERE clinic_id = $1::uuid AND specialty_id <> $2::uuid ORDER BY specialty_id LIMIT 1",
		[target.clinicId, target.specialtyId],
	);
	otherSpecialtyId = specialty.rows[0].specialty_id;

});

afterEach(async () => {
	await setup.query("ROLLBACK");
});

afterAll(async () => {
	await setup.end();
});

it("rejects changed specialty writes by the locking owner", async () => {

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
	await expect(setup.query(
		"UPDATE public.professionals SET specialty_id = $2::uuid WHERE professional_id = $1::uuid",
		[target.professionalId, otherSpecialtyId],
	)).rejects.toMatchObject({
		code: "42501",
		message: 'new row violates row-level security policy for table "professionals"',
	});

});
