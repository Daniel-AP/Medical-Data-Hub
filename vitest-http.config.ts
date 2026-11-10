import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		fileParallelism: false,
		include: [
			"apps/api/tests/routes/audit-records.integration.test.ts",
			"apps/api/tests/routes/clinic-administration.integration.test.ts",
			"apps/api/tests/routes/clinical-notes.integration.test.ts",
			"apps/api/tests/routes/services.integration.test.ts",
			"apps/api/tests/routes/specialties.integration.test.ts",
		],
	},
});
