import { Client, escapeIdentifier } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { User } from "../../../src/generated/prisma/client.js";

type LocalUser = Pick<User, "userId" | "identityId" | "clinicId" | "isActive"> & { role: string };

const setupConnectionString = process.env.DATABASE_SETUP_URL;
const apiConnectionString = process.env.DATABASE_URL;
if (!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const api = new Client({ connectionString: apiConnectionString });
const profileNames = ["clinic_administrator", "reception", "healthcare_professional"];
const readOnlyProfiles = ["reception", "healthcare_professional"];
let users: LocalUser[];
let administrator: LocalUser;
let otherAdministrator: LocalUser;
let target: LocalUser;
let foreignTarget: LocalUser;

beforeAll(async () => {
	await setup.connect();
	await api.connect();
	const result = await setup.query<LocalUser>(`
        SELECT user_id AS "userId", identity_id AS "identityId", clinic_id AS "clinicId", role::text, is_active AS "isActive"
        FROM public.users ORDER BY clinic_id NULLS LAST, user_id
    `);
	users = result.rows;
	administrator = users.find((user) => user.role === "clinic_administrator")!;
	otherAdministrator = users.find(
		(user) => user.role === "clinic_administrator" && user.clinicId !== administrator.clinicId,
	)!;
	target = users.find((user) => user.role === "healthcare_professional" && user.clinicId === administrator.clinicId)!;
	foreignTarget = users.find(
		(user) => user.role === "healthcare_professional" && user.clinicId === otherAdministrator.clinicId,
	)!;
});

afterAll(async () => {
	await api.end();
	await setup.end();
});

it.each(profileNames)("reads only same-clinic user metadata as %s", async (profileName) => {
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	await api.query("BEGIN");
	try {
		await api.query(
			`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
			[actor.userId, actor.clinicId],
		);
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		const { rows } = await api.query(
			"SELECT user_id, clinic_id, role, is_active FROM public.users ORDER BY user_id",
		);
		expect(rows).toEqual(
			users
				.filter((user) => user.clinicId === actor.clinicId)
				.map((user) => ({
					user_id: user.userId,
					clinic_id: user.clinicId,
					role: user.role,
					is_active: user.isActive,
				})),
		);
	} finally {
		await api.query("ROLLBACK");
	}
});

it("allows clinic administrators to read local provider identity identifiers", async () => {
	await api.query("BEGIN");
	try {
		await api.query(
			`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
			[administrator.userId, administrator.clinicId],
		);
		await api.query("SET LOCAL ROLE clinic_administrator");
		const { rows } = await api.query(
			"SELECT user_id, identity_id, clinic_id, role, is_active FROM public.users ORDER BY user_id",
		);
		expect(rows).toEqual(
			users
				.filter((user) => user.clinicId === administrator.clinicId)
				.map((user) => ({
					user_id: user.userId,
					identity_id: user.identityId,
					clinic_id: user.clinicId,
					role: user.role,
					is_active: user.isActive,
				})),
		);
	} finally {
		await api.query("ROLLBACK");
	}
});

it.each(readOnlyProfiles)("denies users.identity_id reads to %s", async (profileName) => {
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	await api.query("BEGIN");
	try {
		await api.query(
			`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
			[actor.userId, actor.clinicId],
		);
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		await expect(api.query("SELECT identity_id FROM public.users")).rejects.toMatchObject({ code: "42501" });
	} finally {
		await api.query("ROLLBACK");
	}
});

it.each(profileNames)("filters another clinic's user as %s", async (profileName) => {
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	await api.query("BEGIN");
	try {
		await api.query(
			`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
			[actor.userId, actor.clinicId],
		);
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		const { rows } = await api.query(
			"SELECT user_id, clinic_id, role, is_active FROM public.users WHERE user_id = $1::uuid",
			[foreignTarget.userId],
		);
		expect(rows).toEqual([]);
	} finally {
		await api.query("ROLLBACK");
	}
});

it.each(profileNames)("filters user reads with empty and NULL context fields as %s", async (profileName) => {
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	for (const [userId, clinicId] of [
		["", actor.clinicId],
		[actor.userId, ""],
		[null, actor.clinicId],
		[actor.userId, null],
	]) {
		await api.query("BEGIN");
		try {
			await api.query(
				`SELECT pg_catalog.set_config('app.user_id', $1, true),
                pg_catalog.set_config('app.clinic_id', $2, true)`,
				[userId, clinicId],
			);
			await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
			const { rows } = await api.query("SELECT user_id, clinic_id, role, is_active FROM public.users");
			expect(rows).toEqual([]);
		} finally {
			await api.query("ROLLBACK");
		}
	}
});

it.each(profileNames)("rejects user reads with malformed context UUIDs as %s", async (profileName) => {
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	for (const [userId, clinicId] of [
		["not-a-uuid", actor.clinicId],
		[actor.userId, "not-a-uuid"],
	]) {
		await api.query("BEGIN");
		try {
			await api.query(
				`SELECT pg_catalog.set_config('app.user_id', $1, true),
                pg_catalog.set_config('app.clinic_id', $2, true)`,
				[userId, clinicId],
			);
			await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
			await expect(
				api.query("SELECT user_id, clinic_id, role, is_active FROM public.users"),
			).rejects.toMatchObject({ code: "22P02" });
		} finally {
			await api.query("ROLLBACK");
		}
	}
});

it("filters user reads on a connection without context settings", async () => {
	const fresh = new Client({ connectionString: apiConnectionString });
	await fresh.connect();
	try {
		await fresh.query("BEGIN");
		await fresh.query("SET LOCAL ROLE reception");
		const { rows } = await fresh.query("SELECT user_id, clinic_id, role, is_active FROM public.users");
		expect(rows).toEqual([]);
	} finally {
		await fresh.query("ROLLBACK");
		await fresh.end();
	}
});

it("allows same-clinic role and activity updates by clinic administrators", async () => {
	await api.query("BEGIN");
	try {
		await api.query(
			`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
			[administrator.userId, administrator.clinicId],
		);
		await api.query("SET LOCAL ROLE clinic_administrator");
		const { rows } = await api.query(
			`UPDATE public.users SET role = $2::public.user_role, is_active = $3
            WHERE user_id = $1::uuid RETURNING user_id, identity_id, clinic_id, role, is_active`,
			[target.userId, "reception", false],
		);
		expect(rows).toEqual([
			{
				user_id: target.userId,
				identity_id: target.identityId,
				clinic_id: target.clinicId,
				role: "reception",
				is_active: false,
			},
		]);
	} finally {
		await api.query("ROLLBACK");
	}
});

it("filters administrative user updates targeting another clinic", async () => {
	await api.query("BEGIN");
	try {
		await api.query(
			`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
			[administrator.userId, administrator.clinicId],
		);
		await api.query("SET LOCAL ROLE clinic_administrator");
		const result = await api.query(
			"UPDATE public.users SET is_active = false WHERE user_id = $1::uuid RETURNING user_id",
			[foreignTarget.userId],
		);
		expect(result.rowCount).toBe(0);
		expect(result.rows).toEqual([]);
	} finally {
		await api.query("ROLLBACK");
	}
});

it("filters administrative user updates with empty and NULL context fields", async () => {
	for (const [userId, clinicId] of [
		["", administrator.clinicId],
		[administrator.userId, ""],
		[null, administrator.clinicId],
		[administrator.userId, null],
	]) {
		await api.query("BEGIN");
		try {
			await api.query(
				`SELECT pg_catalog.set_config('app.user_id', $1, true),
                pg_catalog.set_config('app.clinic_id', $2, true)`,
				[userId, clinicId],
			);
			await api.query("SET LOCAL ROLE clinic_administrator");
			const result = await api.query("UPDATE public.users SET is_active = false WHERE user_id = $1::uuid", [
				target.userId,
			]);
			expect(result.rowCount).toBe(0);
		} finally {
			await api.query("ROLLBACK");
		}
	}
});

it("rejects administrative user updates with malformed context UUIDs", async () => {
	for (const [userId, clinicId] of [
		["not-a-uuid", administrator.clinicId],
		[administrator.userId, "not-a-uuid"],
	]) {
		await api.query("BEGIN");
		try {
			await api.query(
				`SELECT pg_catalog.set_config('app.user_id', $1, true),
                pg_catalog.set_config('app.clinic_id', $2, true)`,
				[userId, clinicId],
			);
			await api.query("SET LOCAL ROLE clinic_administrator");
			await expect(
				api.query("UPDATE public.users SET is_active = false WHERE user_id = $1::uuid", [target.userId]),
			).rejects.toMatchObject({ code: "22P02" });
		} finally {
			await api.query("ROLLBACK");
		}
	}
});

it("allows same-clinic inserts using an existing realm identity", async () => {
	await setup.query("BEGIN");
	try {
		// Free an existing realm identity only within this rolled-back fixture transaction.
		await setup.query("DELETE FROM public.users WHERE user_id = $1::uuid", [otherAdministrator.userId]);
		await setup.query(
			`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
			[administrator.userId, administrator.clinicId],
		);
		await setup.query("SET LOCAL ROLE clinic_administrator");
		const { rows } = await setup.query(
			`INSERT INTO public.users (identity_id, clinic_id, role)
            VALUES ($1, $2::uuid, 'clinic_administrator') RETURNING user_id, identity_id, clinic_id, role, is_active`,
			[otherAdministrator.identityId, administrator.clinicId],
		);
		expect(rows).toEqual([
			{
				user_id: expect.any(String),
				identity_id: otherAdministrator.identityId,
				clinic_id: administrator.clinicId,
				role: "clinic_administrator",
				is_active: true,
			},
		]);
	} finally {
		await setup.query("ROLLBACK");
	}
});

it("rejects user inserts into another clinic through RLS", async () => {
	await api.query("BEGIN");
	try {
		await api.query(
			`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
			[administrator.userId, administrator.clinicId],
		);
		await api.query("SET LOCAL ROLE clinic_administrator");
		await expect(
			api.query("INSERT INTO public.users (identity_id, clinic_id, role) VALUES ($1, $2::uuid, 'reception')", [
				administrator.identityId,
				otherAdministrator.clinicId,
			]),
		).rejects.toMatchObject({
			code: "42501",
			message: 'new row violates row-level security policy for table "users"',
		});
	} finally {
		await api.query("ROLLBACK");
	}
});

it("rejects platform user inserts with a NULL clinic through ordinary administration", async () => {
	await api.query("BEGIN");
	try {
		await api.query(
			`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
			[administrator.userId, administrator.clinicId],
		);
		await api.query("SET LOCAL ROLE clinic_administrator");
		await expect(
			api.query(
				"INSERT INTO public.users (identity_id, clinic_id, role) VALUES ($1, NULL, 'platform_administrator')",
				[administrator.identityId],
			),
		).rejects.toMatchObject({
			code: "42501",
			message: 'new row violates row-level security policy for table "users"',
		});
	} finally {
		await api.query("ROLLBACK");
	}
});

it("rejects user inserts with empty and NULL context fields through RLS", async () => {
	for (const [userId, clinicId] of [
		["", administrator.clinicId],
		[administrator.userId, ""],
		[null, administrator.clinicId],
		[administrator.userId, null],
	]) {
		await api.query("BEGIN");
		try {
			await api.query(
				`SELECT pg_catalog.set_config('app.user_id', $1, true),
                pg_catalog.set_config('app.clinic_id', $2, true)`,
				[userId, clinicId],
			);
			await api.query("SET LOCAL ROLE clinic_administrator");
			await expect(
				api.query(
					"INSERT INTO public.users (identity_id, clinic_id, role) VALUES ($1, $2::uuid, 'reception')",
					[administrator.identityId, administrator.clinicId],
				),
			).rejects.toMatchObject({
				code: "42501",
				message: 'new row violates row-level security policy for table "users"',
			});
		} finally {
			await api.query("ROLLBACK");
		}
	}
});

it("rejects user inserts with malformed context UUIDs", async () => {
	for (const [userId, clinicId] of [
		["not-a-uuid", administrator.clinicId],
		[administrator.userId, "not-a-uuid"],
	]) {
		await api.query("BEGIN");
		try {
			await api.query(
				`SELECT pg_catalog.set_config('app.user_id', $1, true),
                pg_catalog.set_config('app.clinic_id', $2, true)`,
				[userId, clinicId],
			);
			await api.query("SET LOCAL ROLE clinic_administrator");
			await expect(
				api.query(
					"INSERT INTO public.users (identity_id, clinic_id, role) VALUES ($1, $2::uuid, 'reception')",
					[administrator.identityId, administrator.clinicId],
				),
			).rejects.toMatchObject({ code: "22P02" });
		} finally {
			await api.query("ROLLBACK");
		}
	}
});

it("preserves provider identity uniqueness for ordinary user inserts", async () => {
	await api.query("BEGIN");
	try {
		await api.query(
			`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
			[administrator.userId, administrator.clinicId],
		);
		await api.query("SET LOCAL ROLE clinic_administrator");
		await expect(
			api.query("INSERT INTO public.users (identity_id, clinic_id, role) VALUES ($1, $2::uuid, 'reception')", [
				administrator.identityId,
				administrator.clinicId,
			]),
		).rejects.toMatchObject({ code: "23505", constraint: "users_identity_id_key" });
	} finally {
		await api.query("ROLLBACK");
	}
});

it("preserves the role-clinic constraint during ordinary role updates", async () => {
	await api.query("BEGIN");
	try {
		await api.query(
			`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
			[administrator.userId, administrator.clinicId],
		);
		await api.query("SET LOCAL ROLE clinic_administrator");
		await expect(
			api.query("UPDATE public.users SET role = 'platform_administrator' WHERE user_id = $1::uuid", [
				target.userId,
			]),
		).rejects.toMatchObject({ code: "23514", constraint: "users_role_clinic_check" });
	} finally {
		await api.query("ROLLBACK");
	}
});

it.each(["user_id", "identity_id", "clinic_id"])("denies administrative updates to users.%s", async (columnName) => {
	await api.query("BEGIN");
	try {
		await api.query(
			`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
			[administrator.userId, administrator.clinicId],
		);
		await api.query("SET LOCAL ROLE clinic_administrator");
		const column = escapeIdentifier(columnName);
		await expect(
			api.query(`UPDATE public.users SET ${column} = ${column} WHERE user_id = $1::uuid`, [target.userId]),
		).rejects.toMatchObject({ code: "42501" });
	} finally {
		await api.query("ROLLBACK");
	}
});

it.each(readOnlyProfiles)("denies user insert and update operations to %s", async (profileName) => {
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	const operations = [
		{
			query: "INSERT INTO public.users (identity_id, clinic_id, role) VALUES ($1, $2::uuid, 'reception')",
			values: [actor.identityId, actor.clinicId],
		},
		{ query: "UPDATE public.users SET role = 'reception' WHERE user_id = $1::uuid", values: [target.userId] },
		{ query: "UPDATE public.users SET is_active = false WHERE user_id = $1::uuid", values: [target.userId] },
	];
	for (const { query, values } of operations) {
		await api.query("BEGIN");
		try {
			await api.query(
				`SELECT pg_catalog.set_config('app.user_id', $1, true),
                pg_catalog.set_config('app.clinic_id', $2, true)`,
				[actor.userId, actor.clinicId],
			);
			await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
			await expect(api.query(query, values), query).rejects.toMatchObject({ code: "42501" });
		} finally {
			await api.query("ROLLBACK");
		}
	}
});

it.each(profileNames)("denies user deletion and truncation to %s", async (profileName) => {
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	const operations = [
		{ query: "DELETE FROM public.users WHERE user_id = $1::uuid", values: [target.userId] },
		{ query: "TRUNCATE public.users", values: [] },
	];
	for (const { query, values } of operations) {
		await api.query("BEGIN");
		try {
			await api.query(
				`SELECT pg_catalog.set_config('app.user_id', $1, true),
                pg_catalog.set_config('app.clinic_id', $2, true)`,
				[actor.userId, actor.clinicId],
			);
			await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
			await expect(api.query(query, values), query).rejects.toMatchObject({ code: "42501" });
		} finally {
			await api.query("ROLLBACK");
		}
	}
});

it.each(["medical_data_hub_api", "platform_administrator"])(
	"denies ordinary user access to %s despite supplied context",
	async (profileName) => {
		const operations = [
			{ query: "SELECT user_id, clinic_id, role, is_active FROM public.users", values: [] },
			{
				query: "INSERT INTO public.users (identity_id, clinic_id, role) VALUES ($1, $2::uuid, 'reception')",
				values: [administrator.identityId, administrator.clinicId],
			},
			{ query: "UPDATE public.users SET is_active = false WHERE user_id = $1::uuid", values: [target.userId] },
			{ query: "DELETE FROM public.users WHERE user_id = $1::uuid", values: [target.userId] },
		];
		for (const { query, values } of operations) {
			await api.query("BEGIN");
			try {
				await api.query(
					`SELECT pg_catalog.set_config('app.user_id', $1, true),
                pg_catalog.set_config('app.clinic_id', $2, true)`,
					[administrator.userId, administrator.clinicId],
				);
				await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
				await expect(api.query(query, values), query).rejects.toMatchObject({ code: "42501" });
			} finally {
				await api.query("ROLLBACK");
			}
		}
	},
);

it("keeps locking owner writes rejected even with valid ordinary context", async () => {
	await setup.query("BEGIN");
	try {
		await setup.query(
			`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
			[administrator.userId, administrator.clinicId],
		);
		await setup.query("SET LOCAL ROLE medical_data_hub_locking_owner");
		await expect(
			setup.query("UPDATE public.users SET is_active = false WHERE user_id = $1::uuid", [target.userId]),
		).rejects.toMatchObject({
			code: "42501",
			message: 'new row violates row-level security policy for table "users"',
		});
	} finally {
		await setup.query("ROLLBACK");
	}
});

it("grants only the designed ordinary user table and column privileges", async () => {
	const tableGrants = await setup.query(
		`
        SELECT grantee, privilege_type, is_grantable FROM information_schema.table_privileges
        WHERE table_schema = 'public' AND table_name = 'users' AND grantee = ANY($1::text[])
        ORDER BY grantee, privilege_type
    `,
		[profileNames],
	);
	expect(tableGrants.rows).toEqual([
		{ grantee: "clinic_administrator", privilege_type: "INSERT", is_grantable: "NO" },
		{ grantee: "clinic_administrator", privilege_type: "SELECT", is_grantable: "NO" },
	]);
	const updateGrants = await setup.query(
		`
        SELECT grantee, column_name, is_grantable FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = 'users' AND privilege_type = 'UPDATE' AND grantee = ANY($1::text[])
        ORDER BY grantee, column_name
    `,
		[profileNames],
	);
	expect(updateGrants.rows).toEqual([
		{ grantee: "clinic_administrator", column_name: "is_active", is_grantable: "NO" },
		{ grantee: "clinic_administrator", column_name: "role", is_grantable: "NO" },
	]);
	const readOnlyGrants = await setup.query(
		`
        SELECT grantee, column_name, is_grantable FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = 'users' AND privilege_type = 'SELECT' AND grantee = ANY($1::text[])
        ORDER BY grantee, column_name
    `,
		[readOnlyProfiles],
	);
	expect(readOnlyGrants.rows).toEqual(
		[...readOnlyProfiles].sort().flatMap((grantee) => [
			{ grantee, column_name: "clinic_id", is_grantable: "NO" },
			{ grantee, column_name: "is_active", is_grantable: "NO" },
			{ grantee, column_name: "role", is_grantable: "NO" },
			{ grantee, column_name: "user_id", is_grantable: "NO" },
		]),
	);
});

it.each(["COMMIT", "ROLLBACK"])("ends ordinary user context after %s", async (boundary) => {
	await api.query("BEGIN");
	try {
		await api.query(
			`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
			[administrator.userId, administrator.clinicId],
		);
		await api.query("SET LOCAL ROLE clinic_administrator");
		const first = await api.query("SELECT user_id FROM public.users WHERE user_id = $1::uuid", [target.userId]);
		expect(first.rows).toEqual([{ user_id: target.userId }]);
		await api.query(boundary);
		await api.query("BEGIN");
		await api.query("SET LOCAL ROLE clinic_administrator");
		const next = await api.query("SELECT user_id FROM public.users");
		expect(next.rows).toEqual([]);
	} finally {
		await api.query("ROLLBACK");
	}
});

it("uses the current clinic for successive user queries on one connection", async () => {
	for (const clinicId of [administrator.clinicId, otherAdministrator.clinicId]) {
		const actor = users.find((user) => user.role === "reception" && user.clinicId === clinicId)!;
		await api.query("BEGIN");
		try {
			await api.query(
				`SELECT pg_catalog.set_config('app.user_id', $1, true),
                pg_catalog.set_config('app.clinic_id', $2, true)`,
				[actor.userId, clinicId],
			);
			await api.query("SET LOCAL ROLE reception");
			const { rows } = await api.query(
				"SELECT user_id, clinic_id, role, is_active FROM public.users ORDER BY user_id",
			);
			expect(rows).toEqual(
				users
					.filter((user) => user.clinicId === clinicId)
					.map((user) => ({
						user_id: user.userId,
						clinic_id: user.clinicId,
						role: user.role,
						is_active: user.isActive,
					})),
			);
		} finally {
			await api.query("ROLLBACK");
		}
	}
});
