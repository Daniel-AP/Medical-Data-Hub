import { STATUS_CODES } from "node:http";
import express from "express";
import type { ErrorRequestHandler } from "express";
import { TransactionFailure } from "./database/transaction-failure.js";
import { OperationOutcomeUnknownError } from "./operation-outcome-unknown.js";

export const app = express();
export const router = express.Router();

const transientTransactionFailures = new Set([
	"acquisition",
	"connection",
	"lockUnavailable",
	"queryCanceled",
	"retryableAbort",
]);

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const handleError: ErrorRequestHandler = (error, _request, response, _next) => {

	if(error.type === "entity.parse.failed") {
		response.status(400).json({ error: "Invalid JSON" });

		return;
	}

	const transactionFailure = error instanceof TransactionFailure ? error : undefined;
	if(error instanceof OperationOutcomeUnknownError || transactionFailure?.kind === "indeterminateCommit") {
		response.status(500).json({ error: STATUS_CODES[500], code: "OPERATION_OUTCOME_UNKNOWN" });

		return;
	}

	const isTransient = transactionFailure && transientTransactionFailures.has(transactionFailure.kind);
	const status = isTransient ? 503 : (error.status ?? 500);
	response.status(status).json({ error: STATUS_CODES[status] });

};

app.use(express.json());
app.use(router);
app.use((_request, response) => {
	response.status(404).json({ error: "Route not found" });
});
app.use(handleError);
