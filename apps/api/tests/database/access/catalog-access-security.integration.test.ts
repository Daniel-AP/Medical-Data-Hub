import { Client, escapeIdentifier } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { Service, Specialty, User } from "../../../src/generated/prisma/client.js";

type LocalUser = Pick<User, "userId" | "clinicId"> & { role: string };

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
let specialties: Specialty[];
let services: Service[];
let foreignSpecialty: Specialty;

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
	const specialtyResult = await setup.query<Specialty>(`
        SELECT specialty_id AS "specialtyId", clinic_id AS "clinicId", name
        FROM public.specialties ORDER BY specialty_id
    `);
	const serviceResult = await setup.query<Service>(`
        SELECT service_id AS "serviceId", clinic_id AS "clinicId", name, duration_minutes AS "durationMinutes",
            specialty_id AS "specialtyId", is_active AS "isActive"
        FROM public.services ORDER BY service_id
    `);
	specialties = specialtyResult.rows;
	services = serviceResult.rows;
	foreignSpecialty = specialties.find((specialty) => specialty.clinicId === otherAdministrator.clinicId)!;

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
	{ tableName: "specialties", profileName: "clinic_administrator" },
	{ tableName: "services", profileName: "reception" },
])("reads only same-clinic $tableName rows as $profileName", async ({ tableName, profileName }) => {

	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	if(tableName === "specialties") {

		const { rows } = await api.query(
			`SELECT specialty_id AS "specialtyId", clinic_id AS "clinicId", name
            FROM public.specialties ORDER BY specialty_id`,
		);
		expect(rows).toEqual(specialties.filter((specialty) => specialty.clinicId === actor.clinicId));

	} else {

		const { rows } = await api.query(
			`SELECT service_id AS "serviceId", clinic_id AS "clinicId", name, duration_minutes AS "durationMinutes",
                specialty_id AS "specialtyId", is_active AS "isActive"
            FROM public.services ORDER BY service_id`,
		);
		expect(rows).toEqual(services.filter((service) => service.clinicId === actor.clinicId));

	}

});

it("rejects foreign-clinic inserts into specialties through RLS", async () => {

	const tableName = "specialties";
	const query =
		tableName === "specialties"
			? "INSERT INTO public.specialties (clinic_id, name) VALUES ($1::uuid, 'Synthetic specialty')"
			: `INSERT INTO public.services (clinic_id, name, duration_minutes, specialty_id)
            VALUES ($1::uuid, 'Synthetic service', 30, $2::uuid)`;
	const values =
		tableName === "specialties"
			? [otherAdministrator.clinicId]
			: [otherAdministrator.clinicId, foreignSpecialty.specialtyId];
	await expect(api.query(query, values)).rejects.toMatchObject({
		code: "42501",
		message: `new row violates row-level security policy for table "${tableName}"`,
	});

});
