import { defineConfig } from "vitest/config";

export default defineConfig({
	test: { include: ["apps/api/tests/database/**/*.integration.test.ts"], fileParallelism: false },
});
