import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { runAuthorizedTransaction } from "../../../src/database/transactions/authorized-transaction.js";
import type { TransactionClient } from "../../../src/database/transactions/types.js";
import type { Professional, User } from "../../../src/generated/prisma/client.js";
import { UserRole } from "../../../src/generated/prisma/enums.js";

type SeedUser = Pick<User, "userId" | "clinicId" | "identityId"> & { role: string };
type SeedProfessional = Pick<User, "identityId"> & Pick<Professional, "professionalId" | "userId" | "clinicId">;

const setupConnectionString = process.env.DATABASE_SETUP_URL;
const apiConnectionString = process.env.DATABASE_URL;
if(!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const pool = new Pool({ connectionString: apiConnectionString, max: 1 });
let clinicAdmin: SeedUser;
let otherClinicAdmin: SeedUser;
let platformAdmin: SeedUser;

beforeAll(async () => {

	await setup.connect();
	const { rows } = await setup.query<SeedUser>(`
		SELECT user_id AS "userId", clinic_id AS "clinicId", identity_id AS "identityId", role
		FROM public.users
		WHERE role IN ('clinic_administrator', 'platform_administrator')
		ORDER BY clinic_id
	`);
	[clinicAdmin, otherClinicAdmin] = rows.filter((user) => user.role === "clinic_administrator");
	platformAdmin = rows.find((user) => user.role === "platform_administrator")!;

});

afterAll(async () => {
	await pool.end();
	await setup.end();
});

it("authorizes a clinic administrator and scopes the callback to that clinic", async () => {

	const { rows: seededClinics } = await setup.query(
		'SELECT DISTINCT clinic_id AS "clinicId" FROM public.audit_records',
	);
	expect(seededClinics.some((row) => row.clinicId !== clinicAdmin.clinicId)).toBe(true);

	const result = await runAuthorizedTransaction(
		{ identityId: clinicAdmin.identityId, roles: [UserRole.clinicAdministrator] },
		{ name: "readAuditRecords" },
		async (client, actor) => {

			const { rows: isolation } = await client.query("SHOW transaction_isolation");
			expect(isolation).toEqual([{ transaction_isolation: "read committed" }]);

			const { rows: context } = await client.query(`
				SELECT current_user AS role, pg_catalog.current_setting('app.user_id') AS "userId",
				       pg_catalog.current_setting('app.clinic_id') AS "clinicId"
			`);
			const { rows: visibleClinics } = await client.query(
				'SELECT DISTINCT clinic_id AS "clinicId" FROM public.audit_records',
			);

			return { actor, context: context[0], visibleClinics };

		},
		pool,
	);

	expect(result).toEqual({
		actor: { userId: clinicAdmin.userId, clinicId: clinicAdmin.clinicId, role: UserRole.clinicAdministrator },
		context: { userId: clinicAdmin.userId, clinicId: clinicAdmin.clinicId, role: "clinic_administrator" },
		visibleClinics: [{ clinicId: clinicAdmin.clinicId }],
	});

});

it("authorizes the platform administrator for clinic creation without a clinic context", async () => {

	const result = await runAuthorizedTransaction(
		{ identityId: platformAdmin.identityId, roles: [UserRole.platformAdministrator] },
		{ name: "createClinic" },
		async (client, actor) => {

			const { rows } = await client.query(`
				SELECT current_user AS role, pg_catalog.current_setting('app.user_id') AS "userId",
				       NULLIF(pg_catalog.current_setting('app.clinic_id'), '') AS "clinicId",
				       pg_catalog.has_function_privilege('public.create_clinic(text,text,text)', 'EXECUTE') AS "canCreate",
				       pg_catalog.has_any_column_privilege('public.clinics', 'SELECT') AS "canReadClinics"
			`);

			return { actor, permissions: rows[0] };

		},
		pool,
	);

	expect(result).toEqual({
		actor: { userId: platformAdmin.userId, clinicId: null, role: UserRole.platformAdministrator },
		permissions: {
			role: "platform_administrator",
			userId: platformAdmin.userId,
			clinicId: null,
			canCreate: true,
			canReadClinics: false,
		},
	});

});

it("passes the actor's professional association to the callback for own schedule replacement", async () => {

	const { rows } = await setup.query<SeedProfessional>(`
		SELECT local_user.identity_id AS "identityId", professional.professional_id AS "professionalId",
		       professional.user_id AS "userId", professional.clinic_id AS "clinicId"
		FROM public.professionals AS professional
		JOIN public.users AS local_user ON local_user.user_id = professional.user_id
		ORDER BY professional.professional_id
		LIMIT 1
	`);
	const [professional] = rows;

	const result = await runAuthorizedTransaction(
		{ identityId: professional.identityId, roles: [UserRole.healthcareProfessional] },
		{ name: "replaceOwnWeeklySchedule" },
		async (client, actor) => {

			const { rows } = await client.query(`
				SELECT professional_id AS "professionalId" FROM public.lock_own_professional_for_no_key_update()
			`);

			return { actor, lockedProfessionals: rows };

		},
		pool,
	);

	expect(result).toEqual({
		actor: {
			userId: professional.userId,
			clinicId: professional.clinicId,
			role: UserRole.healthcareProfessional,
			professionalId: professional.professionalId,
		},
		lockedProfessionals: [{ professionalId: professional.professionalId }],
	});

});

it("rejects a healthcare professional without a profile before invoking the callback", async () => {

	const callback = vi.fn();
	await setup.query("UPDATE public.users SET role = 'healthcare_professional' WHERE user_id = $1::uuid", [
		clinicAdmin.userId,
	]);
	try {

		await expect(
			runAuthorizedTransaction(
				{ identityId: clinicAdmin.identityId, roles: [UserRole.healthcareProfessional] },
				{ name: "replaceOwnWeeklySchedule" },
				callback,
				pool,
			),
		).rejects.toMatchObject({ status: 403 });
		expect(callback).not.toHaveBeenCalled();

	} finally {
		await setup.query("UPDATE public.users SET role = 'clinic_administrator' WHERE user_id = $1::uuid", [
			clinicAdmin.userId,
		]);
	}

});

it("rejects an identity with no local user before invoking the callback", async () => {

	const callback = vi.fn();
	await expect(
		runAuthorizedTransaction(
			{ identityId: randomUUID(), roles: [UserRole.clinicAdministrator] },
			{ name: "readAuditRecords" },
			callback,
			pool,
		),
	).rejects.toMatchObject({ status: 403 });
	expect(callback).not.toHaveBeenCalled();

});

it("rejects an inactive local actor before invoking the callback", async () => {

	const callback = vi.fn();
	await setup.query("UPDATE public.users SET is_active = false WHERE user_id = $1::uuid", [clinicAdmin.userId]);
	try {

		await expect(
			runAuthorizedTransaction(
				{ identityId: clinicAdmin.identityId, roles: [UserRole.clinicAdministrator] },
				{ name: "readAuditRecords" },
				callback,
				pool,
			),
		).rejects.toMatchObject({ status: 403 });
		expect(callback).not.toHaveBeenCalled();

	} finally {
		await setup.query("UPDATE public.users SET is_active = true WHERE user_id = $1::uuid", [clinicAdmin.userId]);
	}

});

it("rejects a token missing the current local role before invoking the callback", async () => {

	const callback = vi.fn();
	await expect(
		runAuthorizedTransaction(
			{ identityId: clinicAdmin.identityId, roles: [UserRole.reception] },
			{ name: "readAuditRecords" },
			callback,
			pool,
		),
	).rejects.toMatchObject({ status: 403 });
	expect(callback).not.toHaveBeenCalled();

});

it("rejects a local role forbidden for the operation despite a matching token claim", async () => {

	const callback = vi.fn();
	await expect(
		runAuthorizedTransaction(
			{
				identityId: clinicAdmin.identityId,
				roles: [UserRole.clinicAdministrator, UserRole.platformAdministrator],
			},
			{ name: "createClinic" },
			callback,
			pool,
		),
	).rejects.toMatchObject({ status: 403 });
	expect(callback).not.toHaveBeenCalled();

});

it("locks a lower UUID target before the actor and uses the stronger mode only for the target", async () => {

	const { rows } = await setup.query<SeedUser & Pick<User, "isActive">>(
		`SELECT user_id AS "userId", identity_id AS "identityId", clinic_id AS "clinicId", role, is_active AS "isActive"
		 FROM public.users WHERE clinic_id = $1::uuid ORDER BY user_id LIMIT 2`,
		[clinicAdmin.clinicId],
	);
	const [target, actor] = rows;
	const {
		rows: [{ pid: apiPid }],
	} = await pool.query("SELECT pg_catalog.pg_backend_pid() AS pid");
	const {
		rows: [{ pid: setupPid }],
	} = await setup.query("SELECT pg_catalog.pg_backend_pid() AS pid");
	await setup.query("UPDATE public.users SET role = 'clinic_administrator' WHERE user_id = $1::uuid", [actor.userId]);

	let pending: Promise<unknown> | undefined;
	try {

		await setup.query("BEGIN");
		try {

			await setup.query("SELECT user_id FROM public.users WHERE user_id = $1::uuid FOR SHARE", [target.userId]);
			pending = runAuthorizedTransaction(
				{ identityId: actor.identityId, roles: [UserRole.clinicAdministrator] },
				{ name: "updateUserPermissions", targetUserId: target.userId },
				async (_client, context) => {

					const { rows: sharedActor } = await setup.query(
						"SELECT user_id FROM public.users WHERE user_id = $1::uuid FOR SHARE NOWAIT",
						[actor.userId],
					);
					expect(sharedActor).toEqual([{ user_id: actor.userId }]);
					await expect(
						setup.query(
							"SELECT user_id FROM public.users WHERE user_id = $1::uuid FOR NO KEY UPDATE NOWAIT",
							[actor.userId],
						),
					).rejects.toMatchObject({ code: "55P03" });

					return context.targetUser;

				},
				pool,
			).catch((error: unknown) => error);

			await vi.waitFor(async () => {

				const { rows } = await setup.query(
					"SELECT $2::int = ANY(pg_catalog.pg_blocking_pids($1::int)) AS waiting",
					[apiPid, setupPid],
				);
				expect(rows[0]).toEqual({ waiting: true });

			});
			const { rows: unlockedActor } = await setup.query(
				"SELECT user_id FROM public.users WHERE user_id = $1::uuid FOR NO KEY UPDATE NOWAIT",
				[actor.userId],
			);
			expect(unlockedActor).toEqual([{ user_id: actor.userId }]);

		} finally {
			await setup.query("ROLLBACK");
		}

		expect(await pending).toEqual({
			userId: target.userId,
			clinicId: target.clinicId,
			role: target.role,
			isActive: target.isActive,
		});

	} finally {

		await pending;
		await setup.query("UPDATE public.users SET role = $1::public.user_role WHERE user_id = $2::uuid", [
			actor.role,
			actor.userId,
		]);

	}

});

it("uses the stronger lock for a self edit even with an uppercase target UUID", async () => {

	const result = await runAuthorizedTransaction(
		{ identityId: clinicAdmin.identityId, roles: [UserRole.clinicAdministrator] },
		{ name: "updateUserPermissions", targetUserId: clinicAdmin.userId.toUpperCase() },
		async (_client, context) => {

			const { rows } = await setup.query(
				"SELECT user_id FROM public.users WHERE user_id = $1::uuid FOR KEY SHARE NOWAIT",
				[clinicAdmin.userId],
			);
			expect(rows).toEqual([{ user_id: clinicAdmin.userId }]);
			await expect(
				setup.query("SELECT user_id FROM public.users WHERE user_id = $1::uuid FOR SHARE NOWAIT", [
					clinicAdmin.userId,
				]),
			).rejects.toMatchObject({ code: "55P03" });

			return context.targetUser;

		},
		pool,
	);

	expect(result).toEqual({
		userId: clinicAdmin.userId,
		clinicId: clinicAdmin.clinicId,
		role: "clinic_administrator",
		isActive: true,
	});

});

it("rejects a permission edit targeting another clinic before invoking the callback", async () => {

	const { rows } = await setup.query<Pick<User, "userId">>(
		'SELECT user_id AS "userId" FROM public.users WHERE clinic_id <> $1::uuid ORDER BY user_id LIMIT 1',
		[clinicAdmin.clinicId],
	);
	const callback = vi.fn();

	await expect(
		runAuthorizedTransaction(
			{ identityId: clinicAdmin.identityId, roles: [UserRole.clinicAdministrator] },
			{ name: "updateUserPermissions", targetUserId: rows[0].userId },
			callback,
			pool,
		),
	).rejects.toMatchObject({ status: 403 });
	expect(callback).not.toHaveBeenCalled();

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
	{
		timeout: "lock",
		sqlState: "55P03",
		kind: "lockUnavailable",
		query: "SELECT pg_catalog.pg_advisory_xact_lock(42, 1)",
	},
	{ timeout: "statement", sqlState: "57014", kind: "queryCanceled", query: "SELECT pg_catalog.pg_sleep(4)" },
])(
	"rolls back a $timeout timeout without retrying and reuses the clean connection",
	async ({ timeout, sqlState, kind, query }) => {

		const authentication = { identityId: clinicAdmin.identityId, roles: [UserRole.clinicAdministrator] };
		const versionQuery = "SELECT version FROM public.clinic_availability_versions WHERE clinic_id = $1::uuid";
		const sessionQuery = `
		SELECT pg_catalog.pg_backend_pid() AS pid, current_user AS role,
		       NULLIF(pg_catalog.current_setting('app.user_id', true), '') AS "userId",
		       NULLIF(pg_catalog.current_setting('app.clinic_id', true), '') AS "clinicId",
		       pg_catalog.current_setting('lock_timeout') AS "lockTimeout",
		       pg_catalog.current_setting('statement_timeout') AS "statementTimeout"
	`;
		const baseline = await pool.query(sessionQuery);
		const originalVersion = await setup.query(versionQuery, [clinicAdmin.clinicId]);
		const callback = vi.fn(async (client: TransactionClient) => {

			const update = await client.query(
				"UPDATE public.clinic_availability_versions SET version = version + 1 WHERE clinic_id = $1::uuid",
				[clinicAdmin.clinicId],
			);
			expect(update.rowCount).toBe(1);
			await client.query(query);

		});

		const holdLock = timeout === "lock";
		try {

			if(holdLock) {
				await setup.query("BEGIN");
				await setup.query(query);
			}
			await expect(
				runAuthorizedTransaction(authentication, { name: "readAuditRecords" }, callback, pool),
			).rejects.toMatchObject({ stage: "operation", kind, sqlState });

		} finally {
			if(holdLock) {
				await setup.query("ROLLBACK");
			}
		}

		expect(callback).toHaveBeenCalledTimes(1);
		expect((await setup.query(versionQuery, [clinicAdmin.clinicId])).rows).toEqual(originalVersion.rows);
		expect((await pool.query(sessionQuery)).rows).toEqual(baseline.rows);

	},
);

it("keeps the definitive availability version stable across a concurrent commit", async () => {

	const authentication = { identityId: clinicAdmin.identityId, roles: [UserRole.clinicAdministrator] };

	const readVersion = async (client: TransactionClient) => {

		const { rows } = await client.query<{ version: string }>(
			"SELECT version FROM public.clinic_availability_versions WHERE clinic_id = $1::uuid",
			[clinicAdmin.clinicId],
		);

		return rows[0].version;

	};

	const originalVersion = await readVersion(setup);
	try {

		const observed = await runAuthorizedTransaction(
			authentication,
			{ name: "readDefinitiveAvailability" },
			async (client) => {

				const { rows } = await client.query("SHOW transaction_isolation");
				expect(rows).toEqual([{ transaction_isolation: "repeatable read" }]);

				const before = await readVersion(client);
				await setup.query(
					"UPDATE public.clinic_availability_versions SET version = version + 1 WHERE clinic_id = $1::uuid",
					[clinicAdmin.clinicId],
				);

				return { before, after: await readVersion(client) };

			},
			pool,
		);
		expect(observed).toEqual({ before: originalVersion, after: originalVersion });
		const latest = await runAuthorizedTransaction(
			authentication,
			{ name: "readDefinitiveAvailability" },
			readVersion,
			pool,
		);
		expect(latest).toBe((BigInt(originalVersion)+1n).toString());

	} finally {

		await setup.query(
			"UPDATE public.clinic_availability_versions SET version = $1::bigint WHERE clinic_id = $2::uuid",
			[originalVersion, clinicAdmin.clinicId],
		);

	}

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
			async (client, _actor, markKeycloakRoleUpdateStarted) => {

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
					markKeycloakRoleUpdateStarted();
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
