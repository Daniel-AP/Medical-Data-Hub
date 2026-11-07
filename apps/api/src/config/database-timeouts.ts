import { readTimeout } from "./read-timeout.js";

export const databaseTimeouts = {
	acquireMs: readTimeout("DATABASE_ACQUIRE_TIMEOUT_MS", 1000),
	lockMs: readTimeout("DATABASE_LOCK_TIMEOUT_MS", 1000),
	statementMs: readTimeout("DATABASE_STATEMENT_TIMEOUT_MS", 3000),
};
