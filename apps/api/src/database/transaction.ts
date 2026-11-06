import { Pool } from "pg";
import { databaseTimeouts } from "../config/database-timeouts.js";
import type { TransactionClient } from "./types.js";

const runtimePool = new Pool({
	connectionString: process.env.DATABASE_URL,
	connectionTimeoutMillis: databaseTimeouts.acquireMs,
});
runtimePool.on("error", () => console.error("An idle database connection failed"));

const beginStatements = {
	readCommitted: "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE",
	repeatableRead: "BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE",
};

type TransactionIsolation = keyof typeof beginStatements;

export async function runTransaction<T>(
	isolation: TransactionIsolation,
	operation: (client: TransactionClient) => Promise<T>,
	pool = runtimePool,
): Promise<T> {
	const client = await pool.connect();
	let reusable = false;
	let connectionFailed = false;
	const onConnectionError = () => {
		connectionFailed = true;
	};
	client.on("error", onConnectionError);

	try {
		await client.query(beginStatements[isolation]);

		let result: T;
		try {
			await client.query(
				`SELECT pg_catalog.set_config('lock_timeout', $1, true),
				        pg_catalog.set_config('statement_timeout', $2, true),
				        pg_catalog.set_config('app.user_id', '', true),
				        pg_catalog.set_config('app.clinic_id', '', true)`,
				[`${databaseTimeouts.lockMs}ms`, `${databaseTimeouts.statementMs}ms`],
			);
			result = await operation(client);
		} catch (error) {
			try {
				const rollback = await client.query("ROLLBACK");
				reusable = rollback.command === "ROLLBACK";
			} catch {
				// Keep the original failure and discard the connection.
			}
			throw error;
		}

		const commit = await client.query("COMMIT");
		reusable = commit.command === "COMMIT" || commit.command === "ROLLBACK";
		if (commit.command !== "COMMIT") {
			throw new Error("Database transaction did not commit");
		}
		return result;
	} finally {
		client.off("error", onConnectionError);
		client.release(connectionFailed || !reusable);
	}
}
