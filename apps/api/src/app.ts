import { STATUS_CODES } from "node:http";
import express from "express";
import type { ErrorRequestHandler } from "express";
import { KeycloakRoleUpdatePartialError } from "./errors/keycloak-role-update-partial.js";
import { getTransactionErrorResponse } from "./middleware/transaction-error-response.js";

export const app = express();
export const router = express.Router();

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const handleError: ErrorRequestHandler = (error, _request, response, _next) => {

	if(error.type === "entity.parse.failed") {
		response.status(400).json({ error: "Invalid JSON" });

		return;
	}

	const transactionResponse = getTransactionErrorResponse(error);
	if(transactionResponse) {
		response.status(transactionResponse.status).json(transactionResponse.body);

		return;
	}
	if(error instanceof KeycloakRoleUpdatePartialError) {
		response.status(500).json({ error: STATUS_CODES[500], code: "KEYCLOAK_ROLE_UPDATE_PARTIAL" });

		return;
	}

	const status = error.status ?? 500;
	response.status(status).json({ error: STATUS_CODES[status] });

};

app.use(express.json());
app.use(router);
app.use((_request, response) => {
	response.status(404).json({ error: "Route not found" });
});
app.use(handleError);
