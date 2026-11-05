import { Pool } from "pg";
import { afterAll, expect, it } from "vitest";
import { runTransaction } from "../../../src/database/transaction.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
	throw new Error("DATABASE_URL is required for isolated database tests");
}

const pool = new Pool({ connectionString, max: 1 });

afterAll(async () => {
	await pool.end();
});

async function readSession(client: Pick<Pool, "query">) {
	const { rows } = await client.query(`
		SELECT pg_catalog.pg_backend_pid() AS pid, current_user AS role,
		       pg_catalog.current_setting('app.user_id', true) AS "userId",
		       pg_catalog.current_setting('app.clinic_id', true) AS "clinicId"
	`);
	return rows[0];
}

async function setLocalScope(client: Pick<Pool, "query">) {
	await client.query(`
		SELECT pg_catalog.set_config('app.user_id', pg_catalog.gen_random_uuid()::text, true),
		       pg_catalog.set_config('app.clinic_id', pg_catalog.gen_random_uuid()::text, true)
	`);
	await client.query("SET LOCAL ROLE reception");
}

it("returns after commit and reuses the same connection with cleared local context", async () => {
	const { pid } = await readSession(pool);

	const transactionId = await runTransaction(
		"readCommitted",
		async (client) => {
			expect(await readSession(client)).toEqual({ pid, role: "medical_data_hub_api", userId: "", clinicId: "" });
			const { rows } = await client.query(`
				SELECT pg_catalog.current_setting('transaction_isolation') AS isolation,
				       pg_catalog.current_setting('transaction_read_only') AS "readOnly",
				       pg_catalog.pg_current_xact_id()::text AS "transactionId"
			`);
			expect(rows[0]).toMatchObject({ isolation: "read committed", readOnly: "off" });
			await setLocalScope(client);
			return rows[0].transactionId;
		},
		pool,
	);

	const { rows } = await pool.query("SELECT pg_catalog.pg_xact_status($1::xid8) AS status", [transactionId]);
	expect(rows[0]).toEqual({ status: "committed" });
	expect(await readSession(pool)).toEqual({ pid, role: "medical_data_hub_api", userId: "", clinicId: "" });
});

it("rolls back a callback failure and reuses the same connection with cleared local context", async () => {
	const { pid } = await readSession(pool);
	const failure = new Error("Operation failed");

	await expect(
		runTransaction(
			"repeatableRead",
			async (client) => {
				expect(await readSession(client)).toEqual({
					pid,
					role: "medical_data_hub_api",
					userId: "",
					clinicId: "",
				});
				const { rows } = await client.query("SHOW transaction_isolation");
				expect(rows[0]).toEqual({ transaction_isolation: "repeatable read" });
				await setLocalScope(client);
				throw failure;
			},
			pool,
		),
	).rejects.toBe(failure);

	expect(await readSession(pool)).toEqual({ pid, role: "medical_data_hub_api", userId: "", clinicId: "" });
});
