import { Pool } from "pg";
import { afterAll, expect, it, vi } from "vitest";
import { databaseTimeouts } from "../../../src/config/database-timeouts.js";
import { runTransaction } from "../../../src/database/transactions.js";
import type { TransactionClient } from "../../../src/database/types.js";

const connectionString = process.env.DATABASE_URL;
if(!connectionString) {
	throw new Error("DATABASE_URL is required for isolated database tests");
}

const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: databaseTimeouts.acquireMs });

afterAll(async () => {
	await pool.end();
});

const readSession = async (client: Pick<Pool, "query">) => {

	const { rows } = await client.query(`
		SELECT pg_catalog.pg_backend_pid() AS pid, current_user AS role,
		       pg_catalog.current_setting('app.user_id', true) AS "userId",
		       pg_catalog.current_setting('app.clinic_id', true) AS "clinicId"
	`);

	return rows[0];

};

it("reports an indeterminate result without replay when a committed transaction loses its confirmation", async () => {

	const { pid } = await readSession(pool);
	const connection = await pool.connect();
	const query = connection.query.bind(connection);
	const lostConfirmation = new Error("Synthetic loss of commit confirmation");
	const interceptedQuery = vi.spyOn(connection, "query").mockImplementation((...args: unknown[]) => {

		if(args[0] === "COMMIT") {

			return query("COMMIT").then((commit) => {
				expect(commit.command).toBe("COMMIT");
				throw lostConfirmation;
			});

		}

		return Reflect.apply(query, connection, args);

	});
	connection.release();

	let transactionId: string | undefined;
	const callback = vi.fn(async (client: TransactionClient) => {

		const { rows } = await client.query<{ transactionId: string }>(
			'SELECT pg_catalog.pg_current_xact_id()::text AS "transactionId"',
		);
		transactionId = rows[0].transactionId;

		return transactionId;

	});

	try {

		await expect(runTransaction("readCommitted", callback, pool)).rejects.toMatchObject({
			stage: "commit",
			kind: "indeterminateCommit",
			cause: lostConfirmation,
		});
		expect(callback).toHaveBeenCalledTimes(1);

		const { rows } = await pool.query(
			"SELECT pg_catalog.pg_backend_pid() AS pid, pg_catalog.pg_xact_status($1::xid8) AS status",
			[transactionId],
		);
		expect(rows[0]).toEqual({ pid: expect.any(Number), status: "committed" });
		expect(rows[0].pid).not.toBe(pid);

	} finally {
		interceptedQuery.mockRestore();
	}

});
