import { Client, Pool } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { runAuthorizedTransaction } from "../../../src/database/authorization.js";
import type { TransactionClient } from "../../../src/database/types.js";
import type { User } from "../../../src/generated/prisma/client.js";
import { UserRole } from "../../../src/generated/prisma/enums.js";

type SeedUser = Pick<User, "userId" | "clinicId" | "identityId">;

const setupConnectionString = process.env.DATABASE_SETUP_URL;
const apiConnectionString = process.env.DATABASE_URL;
if(!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const pool = new Pool({ connectionString: apiConnectionString, max: 1 });
let clinicAdmin: SeedUser;
let otherClinicAdmin: SeedUser;

beforeAll(async () => {

	await setup.connect();
	const { rows } = await setup.query<SeedUser>(`
		SELECT user_id AS "userId", clinic_id AS "clinicId", identity_id AS "identityId"
		FROM public.users
		WHERE role = 'clinic_administrator'
		ORDER BY clinic_id LIMIT 2
	`);
	[clinicAdmin, otherClinicAdmin] = rows;

});

afterAll(async () => {
	await pool.end();
	await setup.end();
});

it("holds actor authorization until commit and rejects a later phase after deactivation", async () => {

	const authentication = { identityId: clinicAdmin.identityId, roles: [UserRole.clinicAdministrator] };
	const { rows: setupSession } = await setup.query("SELECT pg_catalog.pg_backend_pid() AS pid");
	let deactivation: Promise<unknown> | undefined;

	try {

		const visibleClinics = await runAuthorizedTransaction(
			authentication,
			{ name: "readAuditRecords" },
			async (client) => {

				const { rows: apiSession } = await client.query("SELECT pg_catalog.pg_backend_pid() AS pid");
				deactivation = setup
					.query("UPDATE public.users SET is_active = false WHERE user_id = $1::uuid", [clinicAdmin.userId])
					.catch((error: unknown) => error);

				await vi.waitFor(async () => {

					const { rows } = await client.query(
						"SELECT $2::int = ANY(pg_catalog.pg_blocking_pids($1::int)) AS waiting",
						[setupSession[0].pid, apiSession[0].pid],
					);
					expect(rows).toEqual([{ waiting: true }]);

				});

				const { rows } = await client.query(
					'SELECT DISTINCT clinic_id AS "clinicId" FROM public.audit_records',
				);

				return rows;

			},
			pool,
		);

		expect(visibleClinics).toEqual([{ clinicId: clinicAdmin.clinicId }]);
		expect(await deactivation).toMatchObject({ rowCount: 1 });

		const callback = vi.fn();
		await expect(
			runAuthorizedTransaction(authentication, { name: "readAuditRecords" }, callback, pool),
		).rejects.toMatchObject({ status: 403 });
		expect(callback).not.toHaveBeenCalled();

	} finally {
		await deactivation;
		await setup.query("UPDATE public.users SET is_active = true WHERE user_id = $1::uuid", [clinicAdmin.userId]);
	}

});

it("reuses one connection across clinics after authorized commit and rollback", async () => {

	const firstActor = { identityId: clinicAdmin.identityId, roles: [UserRole.clinicAdministrator] };
	const secondActor = { identityId: otherClinicAdmin.identityId, roles: [UserRole.clinicAdministrator] };
	const failure = new Error("Operation failed");
	const baselineQuery = `
		SELECT pg_catalog.pg_backend_pid() AS pid, current_user AS role,
		       pg_catalog.current_setting('app.user_id', true) AS "userId",
		       pg_catalog.current_setting('app.clinic_id', true) AS "clinicId"
	`;

	const readAuditScope = async (client: TransactionClient) => {

		const { rows } = await client.query(`
			SELECT pg_catalog.pg_backend_pid() AS pid, current_user AS role,
			       pg_catalog.current_setting('app.user_id') AS "userId",
			       ARRAY(SELECT DISTINCT clinic_id FROM public.audit_records) AS "visibleClinics"
		`);

		return rows[0];

	};

	const firstScope = await runAuthorizedTransaction(firstActor, { name: "readAuditRecords" }, readAuditScope, pool);
	const { pid } = firstScope;
	const baseline = [{ pid, role: "medical_data_hub_api", userId: "", clinicId: "" }];
	expect(firstScope).toEqual({
		pid,
		role: "clinic_administrator",
		userId: clinicAdmin.userId,
		visibleClinics: [clinicAdmin.clinicId],
	});
	expect((await pool.query(baselineQuery)).rows).toEqual(baseline);

	await expect(
		runAuthorizedTransaction(
			secondActor,
			{ name: "readAuditRecords" },
			async (client) => {

				expect(await readAuditScope(client)).toEqual({
					pid,
					role: "clinic_administrator",
					userId: otherClinicAdmin.userId,
					visibleClinics: [otherClinicAdmin.clinicId],
				});
				throw failure;

			},
			pool,
		),
	).rejects.toBe(failure);
	expect((await pool.query(baselineQuery)).rows).toEqual(baseline);

	expect(await runAuthorizedTransaction(firstActor, { name: "readAuditRecords" }, readAuditScope, pool)).toEqual(
		firstScope,
	);

});

it.each([
	{ name: "retries a serialization failure and commits using a fresh snapshot", conflicts: 1, executions: 2 },
	{ name: "stops after three executions when every snapshot conflicts", conflicts: 3, executions: 3 },
	{
		name: "does not retry a serialization failure after a provider mutation is marked",
		conflicts: 1,
		executions: 1,
		markMutation: true,
	},
])("$name", async ({ conflicts, executions, markMutation }) => {

	const authentication = { identityId: clinicAdmin.identityId, roles: [UserRole.clinicAdministrator] };
	const versionQuery = "SELECT version FROM public.clinic_availability_versions WHERE clinic_id = $1::uuid";
	const incrementQuery =
		"UPDATE public.clinic_availability_versions SET version = version + 1 WHERE clinic_id = $1::uuid";
	const clinic = [clinicAdmin.clinicId];
	const baseline = (await setup.query<{ version: string }>(versionQuery, clinic)).rows[0].version;
	const snapshots: { version: string; transactionId: string }[] = [];

	try {

		const operation = runAuthorizedTransaction(
			authentication,
			{ name: "readDefinitiveAvailability" },
			async (client, _actor, markRoleUpdateStarted) => {

				const previous = snapshots.at(-1);
				if(previous) {

					const { rows } = await setup.query("SELECT pg_catalog.pg_xact_status($1::xid8) AS status", [
						previous.transactionId,
					]);
					expect(rows).toEqual([{ status: "aborted" }]);

				}

				const { rows } = await client.query<{ version: string; transactionId: string }>(
					`SELECT version, pg_catalog.pg_current_xact_id()::text AS "transactionId"
					 FROM public.clinic_availability_versions WHERE clinic_id = $1::uuid`,
					clinic,
				);
				const [snapshot] = rows;
				snapshots.push(snapshot);
				if(markMutation) {
					markRoleUpdateStarted();
				}
				if(snapshots.length <= conflicts) {
					await setup.query(incrementQuery, clinic);
				}
				await client.query(incrementQuery, clinic);

				return snapshot.version;

			},
			pool,
		);

		if(conflicts === executions) {
			const failure = { stage: "operation", kind: "retryableAbort", sqlState: "40001" };
			await expect(operation).rejects.toMatchObject(markMutation ? { cause: failure } : failure);
		} else {
			await expect(operation).resolves.toBe((BigInt(baseline)+1n).toString());
		}
		const expectedVersions = Array.from({ length: executions }, (_, index) =>
			(BigInt(baseline)+BigInt(index)).toString(),
		);
		expect(snapshots.map(({ version }) => version)).toEqual(expectedVersions);
		expect((await setup.query(versionQuery, clinic)).rows).toEqual([
			{ version: (BigInt(baseline)+BigInt(executions)).toString() },
		]);

	} finally {

		await setup.query(
			"UPDATE public.clinic_availability_versions SET version = $1::bigint WHERE clinic_id = $2::uuid",
			[baseline, clinicAdmin.clinicId],
		);

	}

});
