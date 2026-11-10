import { STATUS_CODES } from "node:http";
import { TransactionFailure } from "./database/transaction-failure.js";
import { OperationOutcomeUnknownError } from "./operation-outcome-unknown.js";

export const getTransactionErrorResponse = (error: unknown) => {

	const kind = error instanceof TransactionFailure ? error.kind : undefined;
	if(error instanceof OperationOutcomeUnknownError || kind === "indeterminateCommit") {
		return { status: 500, body: { error: STATUS_CODES[500], code: "OPERATION_OUTCOME_UNKNOWN" } };
	}

	switch(kind) {

		case "acquisition":
		case "connection":
		case "lockUnavailable":
		case "queryCanceled":
		case "retryableAbort":
			return { status: 503, body: { error: STATUS_CODES[503] } };
		default:
			return undefined;

	}

};
