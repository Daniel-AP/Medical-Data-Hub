import { setTimeout } from "node:timers/promises";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { Service, User } from "../../../src/generated/prisma/client.js";

const setupConnectionString = process.env.DATABASE_SETUP_URL;
const apiConnectionString = process.env.DATABASE_URL;
if(!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const api = new Client({ connectionString: apiConnectionString });
const contender = new Client({ connectionString: apiConnectionString });
const lockQuery = "SELECT * FROM public.lock_service_for_share($1::uuid)";
let actor: Pick<User, "userId" | "clinicId">;
let target: Service;
let foreignService: Service;

beforeAll(async () => {

	await setup.connect();
	await api.connect();
	await contender.connect();
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
	foreignService = services.rows.find((service) => service.clinicId !== actor.clinicId)!;

});

beforeEach(async () => {

	await api.query("BEGIN ISOLATION LEVEL READ COMMITTED");
	await api.query(
		`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
		[actor.userId, actor.clinicId],
	);
	await api.query("SET LOCAL ROLE reception");

});

afterEach(async () => {
	await setup.query("ROLLBACK");
	await contender.query("ROLLBACK");
	await api.query("ROLLBACK");
});

afterAll(async () => {
	await contender.end();
	await api.end();
	await setup.end();
});

it("returns only the protected service identifiers, duration, specialty, and activity", async () => {

	const result = await api.query(lockQuery, [target.serviceId]);
	expect(result.fields.map((field) => field.name)).toEqual([
		"service_id",
		"clinic_id",
		"duration_minutes",
		"specialty_id",
		"is_active",
	]);
	expect(result.rows).toEqual([
		{
			service_id: target.serviceId,
			clinic_id: target.clinicId,
			duration_minutes: target.durationMinutes,
			specialty_id: target.specialtyId,
			is_active: target.isActive,
		},
	]);

});

it("filters and does not lock another clinic's service", async () => {

	const { rows } = await api.query(lockQuery, [foreignService.serviceId]);
	expect(rows).toEqual([]);
	await setup.query("BEGIN");
	const unlocked = await setup.query(
		"SELECT service_id FROM public.services WHERE service_id = $1::uuid FOR UPDATE NOWAIT",
		[foreignService.serviceId],
	);
	expect(unlocked.rows).toEqual([{ service_id: foreignService.serviceId }]);

});

it("acquires FOR SHARE rather than a weaker or exclusive service lock", async () => {

	await api.query(lockQuery, [target.serviceId]);
	await setup.query("BEGIN");
	const shared = await setup.query(
		"SELECT service_id FROM public.services WHERE service_id = $1::uuid FOR SHARE NOWAIT",
		[target.serviceId],
	);
	expect(shared.rows).toEqual([{ service_id: target.serviceId }]);
	await expect(
		setup.query("SELECT service_id FROM public.services WHERE service_id = $1::uuid FOR NO KEY UPDATE NOWAIT", [
			target.serviceId,
		]),
	).rejects.toMatchObject({ code: "55P03" });

});

it("returns committed service values after waiting for a concurrent edit", async () => {

	const fixture = await setup.query(
		`INSERT INTO public.services (clinic_id, name, duration_minutes, specialty_id)
        VALUES ($1::uuid, 'Synthetic lock fixture', 30, $2::uuid) RETURNING service_id`,
		[target.clinicId, target.specialtyId],
	);
	const serviceId = fixture.rows[0].service_id;
	const apiPid = (await api.query("SELECT pg_catalog.pg_backend_pid() AS pid")).rows[0].pid;
	const setupPid = (await setup.query("SELECT pg_catalog.pg_backend_pid() AS pid")).rows[0].pid;
	await setup.query("BEGIN");
	await setup.query(
		"UPDATE public.services SET duration_minutes = 45, is_active = false WHERE service_id = $1::uuid",
		[serviceId],
	);
	const pendingRead = api.query(lockQuery, [serviceId]).catch((error: unknown) => error);
	try {

		let isWaiting = false;
		for(let attempt = 0; attempt < 100; attempt++) {

			const { rows } = await setup.query(
				"SELECT $2::int = ANY(pg_catalog.pg_blocking_pids($1::int)) AS waiting",
				[apiPid, setupPid],
			);
			if(rows[0].waiting) {
				isWaiting = true;
				break;
			}
			await setTimeout(10);

		}
		expect(isWaiting).toBe(true);
		await setup.query("COMMIT");
		expect(await pendingRead).toMatchObject({
			rows: [
				{
					service_id: serviceId,
					clinic_id: target.clinicId,
					duration_minutes: 45,
					specialty_id: target.specialtyId,
					is_active: false,
				},
			],
		});

	} finally {

		await setup.query("ROLLBACK");
		await pendingRead;
		await api.query("ROLLBACK");
		await setup.query("DELETE FROM public.services WHERE service_id = $1::uuid", [serviceId]);

	}

});

it("rejects locking owner service writes using is_active = false", async () => {

	const assignment = "is_active = false";
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
		setup.query(`UPDATE public.services SET ${assignment} WHERE service_id = $1::uuid`, [target.serviceId]),
	).rejects.toMatchObject({
		code: "42501",
		message: 'new row violates row-level security policy for table "services"',
	});

});

it("grants service locking execution only to reception besides the owner", async () => {

	const { rows } = await setup.query(`
        SELECT pg_catalog.pg_get_userbyid(privilege.grantee) AS grantee, privilege.privilege_type, privilege.is_grantable
        FROM pg_catalog.pg_proc AS function_definition
        CROSS JOIN LATERAL pg_catalog.aclexplode(function_definition.proacl) AS privilege
        WHERE function_definition.oid = 'public.lock_service_for_share(uuid)'::regprocedure
            AND privilege.grantee <> function_definition.proowner
        ORDER BY privilege.grantee
    `);
	expect(rows).toEqual([{ grantee: "reception", privilege_type: "EXECUTE", is_grantable: false }]);

});
