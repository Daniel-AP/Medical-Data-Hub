import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { runAuthorizedTransaction } from "../../../src/database/transaction-context.js";
import type { Professional, User } from "../../../src/generated/prisma/client.js";
import { UserRole } from "../../../src/generated/prisma/enums.js";

type SeedUser = Pick<User, "userId" | "clinicId" | "identityId"> & { role: string };
type SeedProfessional = Pick<User, "identityId"> & Pick<Professional, "professionalId" | "userId" | "clinicId">;

const setupConnectionString = process.env.DATABASE_SETUP_URL;
const apiConnectionString = process.env.DATABASE_URL;
if (!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const pool = new Pool({ connectionString: apiConnectionString, max: 1 });
let clinicAdmin: SeedUser;
let platformAdmin: SeedUser;

beforeAll(async () => {
	await setup.connect();
	const { rows } = await setup.query<SeedUser>(`
		SELECT user_id AS "userId", clinic_id AS "clinicId", identity_id AS "identityId", role
		FROM public.users
		WHERE role IN ('clinic_administrator', 'platform_administrator')
		ORDER BY clinic_id
	`);
	clinicAdmin = rows.find((user) => user.role === "clinic_administrator")!;
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
		"readAuditRecords",
		async (client, actor) => {
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
		"createClinic",
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
		"replaceOwnWeeklySchedule",
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
				"replaceOwnWeeklySchedule",
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
			"readAuditRecords",
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
				"readAuditRecords",
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
			"readAuditRecords",
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
			"createClinic",
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
