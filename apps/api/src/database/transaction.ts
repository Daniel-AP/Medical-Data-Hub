import { Pool } from "pg";
import type { PoolClient } from "pg";
import { databaseTimeouts } from "../config/database-timeouts.js";
import { classifyTransactionFailure, TransactionFailure } from "./transaction-failure.js";
import type { TransactionClient, TransactionStage } from "./types.js";

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
	let client: PoolClient | undefined;
	let stage: TransactionStage = "acquire";
	let reusable = false;
	let connectionError: Error | undefined;
	const onConnectionError = (error: Error) => {
		connectionError = error;
	};

	try {
		client = await pool.connect();
		client.on("error", onConnectionError);
		stage = "begin";
		await client.query(beginStatements[isolation]);

		stage = "operation";
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

		stage = "commit";
		const commit = await client.query("COMMIT");
		if (commit.command === "ROLLBACK") {
			reusable = true;
			throw new TransactionFailure(stage, "aborted");
		}
		if (commit.command !== "COMMIT") {
			throw new TransactionFailure(stage, "indeterminateCommit");
		}
		reusable = true;
		return result;
	} catch (error) {
		throw classifyTransactionFailure(stage, error, connectionError !== undefined && connectionError === error);
	} finally {
		client?.off("error", onConnectionError);
		client?.release(connectionError !== undefined || !reusable);
	}
}
