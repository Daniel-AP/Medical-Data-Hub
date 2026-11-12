import { Client, escapeIdentifier } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type {
	Professional,
	ProfessionalService,
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
const tableNames = ["professionals", "professional_services"] as const;
let users: LocalUser[];
let administrator: LocalUser;
let otherAdministrator: LocalUser;
let professionals: Professional[];
let associations: ProfessionalService[];
let foreignProfessional: Professional;

beforeAll(async () => {

	await setup.connect();
	await api.connect();
	const userResult = await setup.query<LocalUser>(`
        SELECT user_id AS "userId", clinic_id AS "clinicId", role::text
        FROM public.users ORDER BY clinic_id NULLS LAST, user_id
    `);
	users = userResult.rows;
	administrator = users.find((user) => user.role === "clinic_administrator")!;
	otherAdministrator = users.find(
		(user) => user.role === "clinic_administrator" && user.clinicId !== administrator.clinicId,
	)!;
	const professionalResult = await setup.query<Professional>(`
        SELECT professional_id AS "professionalId", clinic_id AS "clinicId", user_id AS "userId", specialty_id AS "specialtyId"
        FROM public.professionals ORDER BY professional_id
    `);
	const associationResult = await setup.query<ProfessionalService>(`
        SELECT clinic_id AS "clinicId", professional_id AS "professionalId", service_id AS "serviceId", is_active AS "isActive"
        FROM public.professional_services ORDER BY professional_id, service_id
    `);
	professionals = professionalResult.rows;
	associations = associationResult.rows;
	foreignProfessional = professionals.find((professional) => professional.clinicId === otherAdministrator.clinicId)!;

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

it.each([
	{ tableName: "professionals", profileName: "reception" },
	{ tableName: "professional_services", profileName: "healthcare_professional" },
])("reads only same-clinic $tableName rows as $profileName", async ({ tableName, profileName }) => {

	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	if(tableName === "professionals") {

		const { rows } = await api.query(
			`SELECT professional_id AS "professionalId", clinic_id AS "clinicId", user_id AS "userId", specialty_id AS "specialtyId"
            FROM public.professionals ORDER BY professional_id`,
		);
		expect(rows).toEqual(professionals.filter((professional) => professional.clinicId === actor.clinicId));

	} else {

		const { rows } = await api.query(
			`SELECT clinic_id AS "clinicId", professional_id AS "professionalId", service_id AS "serviceId", is_active AS "isActive"
            FROM public.professional_services ORDER BY professional_id, service_id`,
		);
		expect(rows).toEqual(associations.filter((association) => association.clinicId === actor.clinicId));

	}

});

it.each(tableNames)("filters foreign-clinic %s updates", async (tableName) => {

	const assignment = tableName === "professionals" ? "specialty_id = specialty_id" : "is_active = false";
	const result = await api.query(
		`UPDATE public.${escapeIdentifier(tableName)} SET ${assignment} WHERE professional_id = $1::uuid`,
		[foreignProfessional.professionalId],
	);
	expect(result.rowCount).toBe(0);

});
