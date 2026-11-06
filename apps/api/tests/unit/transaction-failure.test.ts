import { DatabaseError } from "pg";
import { expect, it } from "vitest";
import { classifyTransactionFailure, TransactionFailure } from "../../src/database/transaction-failure.js";

it.each(["40001", "40P01"])("identifies SQLSTATE %s as a retryable abort candidate", (code) => {
	const cause = Object.assign(new DatabaseError("Synthetic failure", 0, "error"), { code });

	const failure = classifyTransactionFailure("operation", cause);
	expect(failure).toBeInstanceOf(TransactionFailure);
	expect(failure).toMatchObject({ stage: "operation", kind: "retryableAbort", sqlState: code, cause });
});

it("preserves a constraint name on a database rejection at commit", () => {
	const cause = Object.assign(new DatabaseError("Synthetic failure", 0, "error"), {
		code: "23505",
		constraint: "users_identity_id_key",
	});

	expect(classifyTransactionFailure("commit", cause)).toMatchObject({
		stage: "commit",
		kind: "aborted",
		sqlState: "23505",
		constraint: "users_identity_id_key",
	});
});

it("distinguishes acquisition and connection failures from an unconfirmed commit", () => {
	const genericError = new Error("Synthetic failure");
	const connectionError = Object.assign(new Error("Synthetic failure"), { code: "ECONNREFUSED" });

	expect(classifyTransactionFailure("acquire", genericError)).toMatchObject({ kind: "acquisition" });
	expect(classifyTransactionFailure("acquire", connectionError)).toMatchObject({ kind: "connection" });
	expect(classifyTransactionFailure("commit", connectionError)).toMatchObject({ kind: "indeterminateCommit" });
});

it("preserves application errors returned by the operation", () => {
	const forbidden = Object.assign(new Error("Operation forbidden"), { status: 403 });
	const conflict = Object.assign(new Error("Operation conflict"), { status: 409 });

	expect(classifyTransactionFailure("operation", forbidden)).toBe(forbidden);
	expect(classifyTransactionFailure("operation", conflict)).toBe(conflict);
});
