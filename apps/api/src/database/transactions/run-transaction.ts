import { randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import type { PoolClient } from "pg";
import { databaseTimeouts } from "../../config/database-timeouts.js";
import { OperationOutcomeUnknownError } from "../../errors/operation-outcome-unknown.js";
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
type TransactionCallback<T> = (client: TransactionClient, markKeycloakRoleUpdateStarted: () => void) => Promise<T>;
type TransactionAttempt<T> =
	| { status: "committed"; result: T }
	| { status: "retry"; failure: TransactionFailure }
	| { status: "failed"; failure: unknown };

const maxAttempts = 3;

export const runTransaction = async <T>(
	isolation: TransactionIsolation,
	callback: TransactionCallback<T>,
	pool = runtimePool,
) => {

	for(let attemptNumber = 1; ; attemptNumber++) {

		const outcome = await runTransactionAttempt(isolation, callback, pool);
		if(outcome.status === "committed") {
			return outcome.result;
		}
		if(outcome.status === "failed" || attemptNumber === maxAttempts) {
			throw outcome.failure;
		}

		await delay(randomInt(101));

	}

};

const rollbackTransaction = async (client: PoolClient) => {

	try {
		const { command } = await client.query("ROLLBACK");

		return command === "ROLLBACK";
	} catch {
		// Keep the original failure and discard the connection
		return false;
	}

};

const runTransactionAttempt = async <T>(
	isolation: TransactionIsolation,
	callback: TransactionCallback<T>,
	pool: Pool,
): Promise<TransactionAttempt<T>> => {

	let client: PoolClient;
	try {
		client = await pool.connect();
	} catch (error) {
		return { status: "failed", failure: classifyTransactionFailure("acquire", error) };
	}

	let stage: Exclude<TransactionStage, "acquire"> | "closed" = "begin";
	let transactionEndConfirmed = false;
	let connectionError: Error | undefined;
	let keycloakRoleUpdateStarted = false;

	const onConnectionError = (error: Error) => {
		connectionError = error;
	};

	const assertOperationActive = () => {
		if(stage !== "operation" || connectionError) {
			throw new Error("Transaction attempt is closed");
		}
	};

	const operationClient: TransactionClient = {
		query: (...args: unknown[]) => {
			assertOperationActive();

			return Reflect.apply(client.query, client, args);
		},
	};

	const markKeycloakRoleUpdateStarted = () => {
		assertOperationActive();
		keycloakRoleUpdateStarted = true;
	};

	try {

		let execution: { command: string; result: T } | { error: unknown };
		try {

			client.on("error", onConnectionError);
			await client.query(beginStatements[isolation]);

			stage = "operation";
			await client.query(
				`SELECT pg_catalog.set_config('lock_timeout', $1, true),
				        pg_catalog.set_config('statement_timeout', $2, true),
				        pg_catalog.set_config('app.user_id', '', true),
				        pg_catalog.set_config('app.clinic_id', '', true)`,
				[`${databaseTimeouts.lockMs}ms`, `${databaseTimeouts.statementMs}ms`],
			);
			const result = await callback(operationClient, markKeycloakRoleUpdateStarted);

			stage = "commit";
			const { command } = await client.query("COMMIT");
			execution = { command, result };

		} catch (error) {
			execution = { error };
		}

		const failureStage = stage;
		stage = "closed";

		let failure: unknown;
		let retryableFailure: TransactionFailure | undefined;
		if("command" in execution) {

			const { command, result } = execution;
			if(command === "COMMIT") {
				transactionEndConfirmed = true;

				return { status: "committed", result };
			}

			transactionEndConfirmed = command === "ROLLBACK";
			failure = new TransactionFailure("commit", transactionEndConfirmed ? "aborted" : "indeterminateCommit");

		} else {

			const { error } = execution;
			const failedOnConnectionError = connectionError !== undefined && connectionError === error;
			failure = classifyTransactionFailure(failureStage, error, failedOnConnectionError);
			if(failure instanceof TransactionFailure && failure !== error && failure.kind === "retryableAbort") {
				retryableFailure = failure;
			}

		}

		const shouldRollback = !connectionError && (failureStage === "operation" || retryableFailure !== undefined);
		if(shouldRollback) {
			transactionEndConfirmed = await rollbackTransaction(client);
		}

		if(retryableFailure && transactionEndConfirmed && !connectionError && !keycloakRoleUpdateStarted) {
			return { status: "retry", failure: retryableFailure };
		}

		if(keycloakRoleUpdateStarted && failure instanceof TransactionFailure) {
			return { status: "failed", failure: new OperationOutcomeUnknownError(failure) };
		}

		return { status: "failed", failure };

	} finally {
		client.off("error", onConnectionError);
		const discardConnection = !transactionEndConfirmed || connectionError !== undefined;
		client.release(discardConnection);
	}

};
