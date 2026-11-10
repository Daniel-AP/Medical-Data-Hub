import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: [
			"apps/api/tests/routes/audit-records.integration.test.ts",
			"apps/api/tests/routes/registrations.integration.test.ts",
		],
	},
});
