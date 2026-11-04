import { prisma } from "../src/database/client.js";

try {
	const apiDatabaseUrl = process.env.API_DATABASE_URL;
	if (!process.env.DATABASE_URL || !apiDatabaseUrl) {
		throw new Error("DATABASE_URL and API_DATABASE_URL are required");
	}

	const { username, password } = new URL(apiDatabaseUrl);
	const hasApiCredentials = decodeURIComponent(username) === "medical_data_hub_api" && password.length > 0;
	if (!hasApiCredentials) {
		throw new Error("API_DATABASE_URL must contain the API login and its password");
	}

	await prisma.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT set_config('app.api_login_password', ${decodeURIComponent(password)}, true)`;
		await tx.$executeRaw`
            DO $setup$
            BEGIN
                EXECUTE format(
                    'ALTER ROLE medical_data_hub_api PASSWORD %L',
                    current_setting('app.api_login_password')
                );
            END
            $setup$;
        `;
	});
	console.log("API database login configured.");
} catch {
	console.error("API database login configuration failed.");
	process.exitCode = 1;
} finally {
	await prisma.$disconnect();
}
