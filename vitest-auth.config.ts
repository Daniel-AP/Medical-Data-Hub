import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: [
			"apps/api/tests/middleware/**/*.integration.test.ts",
			"apps/api/tests/routes/logout.integration.test.ts",
		],
		fileParallelism: false,
	},
});
