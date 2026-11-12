import { DatabaseError } from "pg";
import { expect, it } from "vitest";
import { classifyTransactionFailure, TransactionFailure } from "../../../src/database/transaction-errors.js";

it.each(["40001", "40P01"])("identifies SQLSTATE %s as a retryable abort candidate", (code) => {

	const cause = Object.assign(new DatabaseError("Synthetic failure", 0, "error"), { code });

	const failure = classifyTransactionFailure("operation", cause);
	expect(failure).toBeInstanceOf(TransactionFailure);
	expect(failure).toMatchObject({ stage: "operation", kind: "retryableAbort", sqlState: code, cause });

});
