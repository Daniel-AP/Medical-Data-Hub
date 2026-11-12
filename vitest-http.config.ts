import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		fileParallelism: false,
		include: ["apps/api/tests/routes/**/*.integration.test.ts"],
		exclude: [...configDefaults.exclude, "apps/api/tests/routes/logout.integration.test.ts"],
	},
});
