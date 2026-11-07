import { randomInt } from "node:crypto";
import { setTimeout } from "node:timers/promises";
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
type TransactionOperation<T> = (client: TransactionClient, markProviderMutationSent: () => void) => Promise<T>;
const maxAttempts = 3;

export async function runTransaction<T>(
	isolation: TransactionIsolation,
	operation: TransactionOperation<T>,
	pool = runtimePool,
): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		const outcome = await runTransactionAttempt(isolation, operation, pool);
		if ("result" in outcome) {
			return outcome.result;
		}
		if (attempt === maxAttempts) {
			throw outcome.retry;
		}
		await setTimeout(randomInt(101));
	}
}

async function rollbackTransaction(client: PoolClient) {
	try {
		const rollback = await client.query("ROLLBACK");
		return rollback.command === "ROLLBACK";
	} catch {
		// Keep the original failure and discard the connection.
		return false;
	}
}

async function runTransactionAttempt<T>(
	isolation: TransactionIsolation,
	operation: TransactionOperation<T>,
	pool: Pool,
): Promise<{ result: T } | { retry: TransactionFailure }> {
	let checkedOutClient: PoolClient | undefined;
	let stage: TransactionStage = "acquire";
	let reusable = false;
	let attemptOpen = true;
	let providerMutationSent = false;
	let connectionError: Error | undefined;
	const onConnectionError = (error: Error) => {
		connectionError = error;
		attemptOpen = false;
	};

	try {
		const client = await pool.connect();
		checkedOutClient = client;
		client.on("error", onConnectionError);
		stage = "begin";
		await client.query(beginStatements[isolation]);

		stage = "operation";
		await client.query(
			`SELECT pg_catalog.set_config('lock_timeout', $1, true),
			        pg_catalog.set_config('statement_timeout', $2, true),
			        pg_catalog.set_config('app.user_id', '', true),
			        pg_catalog.set_config('app.clinic_id', '', true)`,
			[`${databaseTimeouts.lockMs}ms`, `${databaseTimeouts.statementMs}ms`],
		);
		const assertAttemptOpen = () => {
			if (!attemptOpen) {
				throw new Error("Transaction attempt is closed");
			}
		};
		const scopedClient: TransactionClient = {
			query: (...args: unknown[]) => {
				assertAttemptOpen();
				return Reflect.apply(client.query, client, args);
			},
		};
		const markProviderMutationSent = () => {
			assertAttemptOpen();
			providerMutationSent = true;
		};
		let result: T;
		try {
			result = await operation(scopedClient, markProviderMutationSent);
		} finally {
			attemptOpen = false;
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
		return { result };
	} catch (error) {
		if (checkedOutClient && stage === "operation") {
			reusable = await rollbackTransaction(checkedOutClient);
		}
		const failure = classifyTransactionFailure(
			stage,
			error,
			connectionError !== undefined && connectionError === error,
		);
		const retryableAbort =
			failure instanceof TransactionFailure && failure !== error && failure.kind === "retryableAbort";
		if (!retryableAbort || connectionError) {
			throw failure;
		}
		if (checkedOutClient && stage !== "operation") {
			reusable = await rollbackTransaction(checkedOutClient);
		}
		if (!reusable || connectionError || providerMutationSent) {
			throw failure;
		}
		return { retry: failure };
	} finally {
		checkedOutClient?.off("error", onConnectionError);
		checkedOutClient?.release(connectionError !== undefined || !reusable);
	}
}
