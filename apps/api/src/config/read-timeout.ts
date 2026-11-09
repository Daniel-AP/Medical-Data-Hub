export const readTimeout = (name: string, defaultValue: number) => {
	const value = process.env[name];
	if (value === undefined) {
		return defaultValue;
	}

	const milliseconds = Number(value);
	if (!/^\d+$/.test(value) || milliseconds < 1 || milliseconds > 2_147_483_647) {
		throw new Error(`${name} must be an integer between 1 and 2147483647 milliseconds`);
	}

	return milliseconds;
};
