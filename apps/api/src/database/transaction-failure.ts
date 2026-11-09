import { DatabaseError } from "pg";
import type { TransactionStage } from "./types.js";

type FailureKind =
	| "acquisition"
	| "connection"
	| "lockUnavailable"
	| "queryCanceled"
	| "retryableAbort"
	| "aborted"
	| "indeterminateCommit"
	| "database";

export class TransactionFailure extends Error {
	readonly sqlState?: string;
	readonly constraint?: string;

	constructor(
		readonly stage: TransactionStage,
		readonly kind: FailureKind,
		cause?: unknown,
	) {
		super("Database transaction failed", { cause });
		if (cause instanceof DatabaseError) {
			this.sqlState = cause.code;
			this.constraint = cause.constraint;
		}
	}
}

const connectionErrorCodes = new Set([
	"EAI_AGAIN",
	"ECONNREFUSED",
	"ECONNRESET",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"ENOTFOUND",
	"EPIPE",
	"ETIMEDOUT",
]);

export const classifyTransactionFailure = (
	stage: TransactionStage,
	cause: unknown,
	connectionLost = false,
): unknown => {
	if (cause instanceof TransactionFailure) {
		return cause;
	}
	if (stage === "acquire") {
		return new TransactionFailure(stage, "acquisition", cause);
	}

	const sqlState = cause instanceof DatabaseError ? cause.code : undefined;
	if (sqlState === "40001" || sqlState === "40P01") {
		return new TransactionFailure(stage, "retryableAbort", cause);
	}

	if (stage === "commit") {
		const kind = sqlState?.startsWith("23") ? "aborted" : "indeterminateCommit";
		return new TransactionFailure(stage, kind, cause);
	}

	const serverConnectionFailure =
		sqlState?.startsWith("08") || sqlState === "57P01" || sqlState === "57P02" || sqlState === "57P03";
	const transportFailure =
		stage === "begin" &&
		cause instanceof Error &&
		"code" in cause &&
		typeof cause.code === "string" &&
		connectionErrorCodes.has(cause.code);
	if (connectionLost || serverConnectionFailure || transportFailure) {
		return new TransactionFailure(stage, "connection", cause);
	}
	if (sqlState === "55P03") {
		return new TransactionFailure(stage, "lockUnavailable", cause);
	}
	if (sqlState === "57014") {
		return new TransactionFailure(stage, "queryCanceled", cause);
	}
	if (cause instanceof DatabaseError) {
		return new TransactionFailure(stage, "database", cause);
	}
	return cause;
};
