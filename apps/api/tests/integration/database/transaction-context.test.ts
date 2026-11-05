import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { runAuthorizedTransaction } from "../../../src/database/transaction-context.js";
import type { User } from "../../../src/generated/prisma/client.js";
import { UserRole } from "../../../src/generated/prisma/enums.js";

type SeedUser = Pick<User, "userId" | "clinicId" | "identityId"> & { role: string };

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
