import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["apps/api/tests/integration/http/*.test.ts"] } });
