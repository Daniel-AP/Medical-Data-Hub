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
const profileNames = ["clinic_administrator", "reception", "healthcare_professional"];
const tableNames = ["specialties", "services"] as const;
let users: LocalUser[];
let administrator: LocalUser;
let otherAdministrator: LocalUser;
let specialties: Specialty[];
let services: Service[];
let localSpecialty: Specialty;
let foreignSpecialty: Specialty;
let foreignService: Service;

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
	localSpecialty = specialties.find((specialty) => specialty.clinicId === administrator.clinicId)!;
	foreignSpecialty = specialties.find((specialty) => specialty.clinicId === otherAdministrator.clinicId)!;
	foreignService = services.find((service) => service.clinicId === otherAdministrator.clinicId)!;

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

it("allows same-clinic specialty insertion by clinic administrators", async () => {

	const { rows } = await api.query(
		"INSERT INTO public.specialties (clinic_id, name) VALUES ($1::uuid, $2) RETURNING specialty_id, clinic_id, name",
		[administrator.clinicId, "Synthetic specialty"],
	);
	expect(rows).toEqual([
		{ specialty_id: expect.any(String), clinic_id: administrator.clinicId, name: "Synthetic specialty" },
	]);

});

it("allows same-clinic service insertion by clinic administrators", async () => {

	const { rows } = await api.query(
		`INSERT INTO public.services (clinic_id, name, duration_minutes, specialty_id)
        VALUES ($1::uuid, $2, $3, $4::uuid) RETURNING service_id, clinic_id, name, duration_minutes, specialty_id, is_active`,
		[administrator.clinicId, "Synthetic service", 30, localSpecialty.specialtyId],
	);
	expect(rows).toEqual([
		{
			service_id: expect.any(String),
			clinic_id: administrator.clinicId,
			name: "Synthetic service",
			duration_minutes: 30,
			specialty_id: localSpecialty.specialtyId,
			is_active: true,
		},
	]);

});

it("allows updates to all four editable service fields", async () => {

	const inserted = await api.query(
		`INSERT INTO public.services (clinic_id, name, duration_minutes, specialty_id)
        VALUES ($1::uuid, 'Synthetic service', 30, $2::uuid) RETURNING service_id`,
		[administrator.clinicId, localSpecialty.specialtyId],
	);
	const nextSpecialty = specialties.find(
		(specialty) =>
			specialty.clinicId === administrator.clinicId && specialty.specialtyId !== localSpecialty.specialtyId,
	)!;
	const { rows } = await api.query(
		`UPDATE public.services SET name = $2, duration_minutes = $3, specialty_id = $4::uuid, is_active = $5
        WHERE service_id = $1::uuid RETURNING service_id, clinic_id, name, duration_minutes, specialty_id, is_active`,
		[inserted.rows[0].service_id, "Updated synthetic service", 45, nextSpecialty.specialtyId, false],
	);
	expect(rows).toEqual([
		{
			service_id: inserted.rows[0].service_id,
			clinic_id: administrator.clinicId,
			name: "Updated synthetic service",
			duration_minutes: 45,
			specialty_id: nextSpecialty.specialtyId,
			is_active: false,
		},
	]);

});

it("filters service updates targeting another clinic", async () => {

	const result = await api.query("UPDATE public.services SET is_active = false WHERE service_id = $1::uuid", [
		foreignService.serviceId,
	]);
	expect(result.rowCount).toBe(0);

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

it("grants only the designed catalog table and column privileges", async () => {

	const roles = [
		"medical_data_hub_api",
		"platform_administrator",
		...profileNames,
		"medical_data_hub_identity_owner",
		"medical_data_hub_metadata_owner",
		"medical_data_hub_locking_owner",
	];
	const tableGrants = await setup.query(
		`SELECT table_name, grantee, privilege_type, is_grantable FROM information_schema.table_privileges
        WHERE table_schema = 'public' AND table_name = ANY($1::text[]) AND grantee = ANY($2::text[])
        ORDER BY table_name, grantee, privilege_type`,
		[tableNames, roles],
	);
	expect(tableGrants.rows).toEqual([
		{ table_name: "services", grantee: "clinic_administrator", privilege_type: "INSERT", is_grantable: "NO" },
		{ table_name: "services", grantee: "clinic_administrator", privilege_type: "SELECT", is_grantable: "NO" },
		{ table_name: "services", grantee: "healthcare_professional", privilege_type: "SELECT", is_grantable: "NO" },
		{ table_name: "services", grantee: "reception", privilege_type: "SELECT", is_grantable: "NO" },
		{ table_name: "specialties", grantee: "clinic_administrator", privilege_type: "INSERT", is_grantable: "NO" },
		{ table_name: "specialties", grantee: "clinic_administrator", privilege_type: "SELECT", is_grantable: "NO" },
	]);
	const updateGrants = await setup.query(
		`SELECT table_name, grantee, column_name, is_grantable FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = ANY($1::text[]) AND grantee = ANY($2::text[]) AND privilege_type = 'UPDATE'
        ORDER BY table_name, grantee, column_name`,
		[tableNames, roles],
	);
	expect(updateGrants.rows).toEqual([
		...["duration_minutes", "is_active", "name", "specialty_id"].map((columnName) => ({
			table_name: "services",
			grantee: "clinic_administrator",
			column_name: columnName,
			is_grantable: "NO",
		})),
		{
			table_name: "services",
			grantee: "medical_data_hub_locking_owner",
			column_name: "is_active",
			is_grantable: "NO",
		},
	]);

});
