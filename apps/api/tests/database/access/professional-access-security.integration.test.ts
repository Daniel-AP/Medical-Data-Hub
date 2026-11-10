import { Client, escapeIdentifier } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type {
	Professional,
	ProfessionalService,
	Service,
	Specialty,
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
const profileNames = ["clinic_administrator", "reception", "healthcare_professional"];
const tableNames = ["professionals", "professional_services"] as const;
let users: LocalUser[];
let administrator: LocalUser;
let otherAdministrator: LocalUser;
let unassignedUser: LocalUser;
let professionals: Professional[];
let associations: ProfessionalService[];
let specialties: Specialty[];
let services: Service[];
let localProfessional: Professional;
let foreignProfessional: Professional;
let foreignService: Service;
let localSpecialty: Specialty;

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
	unassignedUser = users.find((user) => user.role === "reception" && user.clinicId === administrator.clinicId)!;
	const professionalResult = await setup.query<Professional>(`
        SELECT professional_id AS "professionalId", clinic_id AS "clinicId", user_id AS "userId", specialty_id AS "specialtyId"
        FROM public.professionals ORDER BY professional_id
    `);
	const associationResult = await setup.query<ProfessionalService>(`
        SELECT clinic_id AS "clinicId", professional_id AS "professionalId", service_id AS "serviceId", is_active AS "isActive"
        FROM public.professional_services ORDER BY professional_id, service_id
    `);
	const specialtyResult = await setup.query<Specialty>(`
        SELECT specialty_id AS "specialtyId", clinic_id AS "clinicId", name
        FROM public.specialties ORDER BY specialty_id
    `);
	const serviceResult = await setup.query<Service>(`
        SELECT service_id AS "serviceId", clinic_id AS "clinicId", name, duration_minutes AS "durationMinutes",
            specialty_id AS "specialtyId", is_active AS "isActive"
        FROM public.services ORDER BY service_id
    `);
	professionals = professionalResult.rows;
	associations = associationResult.rows;
	specialties = specialtyResult.rows;
	services = serviceResult.rows;
	localProfessional = professionals.find((professional) => professional.clinicId === administrator.clinicId)!;
	foreignProfessional = professionals.find((professional) => professional.clinicId === otherAdministrator.clinicId)!;
	foreignService = services.find((service) => service.clinicId === otherAdministrator.clinicId)!;
	localSpecialty = specialties.find((specialty) => specialty.clinicId === administrator.clinicId)!;

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

it("allows same-clinic professional insertion and specialty updates", async () => {

	await setup.query("BEGIN");
	try {

		await setup.query("UPDATE public.users SET role = 'healthcare_professional' WHERE user_id = $1::uuid", [
			unassignedUser.userId,
		]);
		await setup.query(
			`SELECT pg_catalog.set_config('app.user_id', $1, true),
                pg_catalog.set_config('app.clinic_id', $2, true)`,
			[administrator.userId, administrator.clinicId],
		);
		await setup.query("SET LOCAL ROLE clinic_administrator");
		const inserted = await setup.query(
			`INSERT INTO public.professionals (clinic_id, user_id, specialty_id)
            VALUES ($1::uuid, $2::uuid, $3::uuid) RETURNING professional_id, clinic_id, user_id, specialty_id`,
			[administrator.clinicId, unassignedUser.userId, localSpecialty.specialtyId],
		);
		expect(inserted.rows).toEqual([
			{
				professional_id: expect.any(String),
				clinic_id: administrator.clinicId,
				user_id: unassignedUser.userId,
				specialty_id: localSpecialty.specialtyId,
			},
		]);
		const nextSpecialty = specialties.find(
			(specialty) =>
				specialty.clinicId === administrator.clinicId && specialty.specialtyId !== localSpecialty.specialtyId,
		)!;
		const updated = await setup.query(
			`UPDATE public.professionals SET specialty_id = $2::uuid WHERE professional_id = $1::uuid
            RETURNING professional_id, clinic_id, user_id, specialty_id`,
			[inserted.rows[0].professional_id, nextSpecialty.specialtyId],
		);
		expect(updated.rows).toEqual([{ ...inserted.rows[0], specialty_id: nextSpecialty.specialtyId }]);

	} finally {
		await setup.query("ROLLBACK");
	}

});

it("allows same-clinic professional service insertion and activity updates", async () => {

	const service = await api.query(
		`INSERT INTO public.services (clinic_id, name, duration_minutes, specialty_id)
        VALUES ($1::uuid, 'Synthetic service', 30, $2::uuid) RETURNING service_id`,
		[administrator.clinicId, localProfessional.specialtyId],
	);
	const inserted = await api.query(
		`INSERT INTO public.professional_services (clinic_id, professional_id, service_id)
        VALUES ($1::uuid, $2::uuid, $3::uuid) RETURNING clinic_id, professional_id, service_id, is_active`,
		[administrator.clinicId, localProfessional.professionalId, service.rows[0].service_id],
	);
	expect(inserted.rows).toEqual([
		{
			clinic_id: administrator.clinicId,
			professional_id: localProfessional.professionalId,
			service_id: service.rows[0].service_id,
			is_active: true,
		},
	]);
	const updated = await api.query(
		`UPDATE public.professional_services SET is_active = false
        WHERE professional_id = $1::uuid AND service_id = $2::uuid RETURNING clinic_id, professional_id, service_id, is_active`,
		[localProfessional.professionalId, service.rows[0].service_id],
	);
	expect(updated.rows).toEqual([{ ...inserted.rows[0], is_active: false }]);

});

it.each(tableNames)("filters foreign-clinic %s updates", async (tableName) => {

	const assignment = tableName === "professionals" ? "specialty_id = specialty_id" : "is_active = false";
	const result = await api.query(
		`UPDATE public.${escapeIdentifier(tableName)} SET ${assignment} WHERE professional_id = $1::uuid`,
		[foreignProfessional.professionalId],
	);
	expect(result.rowCount).toBe(0);

});

it("rejects foreign-clinic inserts into professionals through RLS", async () => {

	const tableName = "professionals";
	const query =
		tableName === "professionals"
			? "INSERT INTO public.professionals (clinic_id, user_id, specialty_id) VALUES ($1::uuid, $2::uuid, $3::uuid)"
			: "INSERT INTO public.professional_services (clinic_id, professional_id, service_id) VALUES ($1::uuid, $2::uuid, $3::uuid)";
	const values =
		tableName === "professionals"
			? [otherAdministrator.clinicId, foreignProfessional.userId, foreignProfessional.specialtyId]
			: [otherAdministrator.clinicId, foreignProfessional.professionalId, foreignService.serviceId];
	await expect(api.query(query, values)).rejects.toMatchObject({
		code: "42501",
		message: `new row violates row-level security policy for table "${tableName}"`,
	});

});

it("grants only the designed professional table and column privileges", async () => {

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
	expect(tableGrants.rows).toEqual(
		[...tableNames].sort().flatMap((tableName) => [
			{ table_name: tableName, grantee: "clinic_administrator", privilege_type: "INSERT", is_grantable: "NO" },
			{ table_name: tableName, grantee: "clinic_administrator", privilege_type: "SELECT", is_grantable: "NO" },
			{ table_name: tableName, grantee: "healthcare_professional", privilege_type: "SELECT", is_grantable: "NO" },
			{ table_name: tableName, grantee: "reception", privilege_type: "SELECT", is_grantable: "NO" },
		]),
	);
	const updateGrants = await setup.query(
		`SELECT table_name, grantee, column_name, is_grantable FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = ANY($1::text[]) AND grantee = ANY($2::text[]) AND privilege_type = 'UPDATE'
        ORDER BY table_name, grantee, column_name`,
		[tableNames, roles],
	);
	expect(updateGrants.rows).toEqual([
		{
			table_name: "professional_services",
			grantee: "clinic_administrator",
			column_name: "is_active",
			is_grantable: "NO",
		},
		{
			table_name: "professionals",
			grantee: "clinic_administrator",
			column_name: "specialty_id",
			is_grantable: "NO",
		},
		{
			table_name: "professionals",
			grantee: "medical_data_hub_locking_owner",
			column_name: "specialty_id",
			is_grantable: "NO",
		},
	]);
	const metadataGrants = await setup.query(
		`SELECT table_name, column_name, privilege_type, is_grantable FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = ANY($1::text[]) AND grantee = 'medical_data_hub_metadata_owner'
        ORDER BY table_name, column_name, privilege_type`,
		[tableNames],
	);
	expect(metadataGrants.rows).toEqual(
		["clinic_id", "professional_id", "user_id"].map((columnName) => ({
			table_name: "professionals",
			column_name: columnName,
			privilege_type: "SELECT",
			is_grantable: "NO",
		})),
	);

});
