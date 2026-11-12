import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type {
	Professional,
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
