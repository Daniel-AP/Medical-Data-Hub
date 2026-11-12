import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		fileParallelism: false,
		include: [
			"apps/api/tests/routes/appointments.integration.test.ts",
			"apps/api/tests/routes/availability.integration.test.ts",
			"apps/api/tests/routes/schedules.integration.test.ts",
			"apps/api/tests/routes/patients.integration.test.ts",
			"apps/api/tests/routes/appointment-agendas.integration.test.ts",
			"apps/api/tests/routes/appointment-counts.integration.test.ts",
			"apps/api/tests/routes/appointment-queries.integration.test.ts",
			"apps/api/tests/routes/audit-records.integration.test.ts",
			"apps/api/tests/routes/clinic-administration.integration.test.ts",
			"apps/api/tests/routes/clinical-notes.integration.test.ts",
			"apps/api/tests/routes/professional-services.integration.test.ts",
			"apps/api/tests/routes/professionals.integration.test.ts",
			"apps/api/tests/routes/services.integration.test.ts",
			"apps/api/tests/routes/specialties.integration.test.ts",
		],
	},
});
