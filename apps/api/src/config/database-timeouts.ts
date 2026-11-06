function readTimeout(name: string, defaultValue: number) {
	const value = process.env[name];
	if (value === undefined) {
		return defaultValue;
	}

	const milliseconds = Number(value);
	if (!/^\d+$/.test(value) || milliseconds < 1 || milliseconds > 2_147_483_647) {
		throw new Error(`${name} must be an integer between 1 and 2147483647 milliseconds`);
	}

	return milliseconds;
}

export const databaseTimeouts = {
	acquireMs: readTimeout("DATABASE_ACQUIRE_TIMEOUT_MS", 1000),
	lockMs: readTimeout("DATABASE_LOCK_TIMEOUT_MS", 1000),
	statementMs: readTimeout("DATABASE_STATEMENT_TIMEOUT_MS", 3000),
};
