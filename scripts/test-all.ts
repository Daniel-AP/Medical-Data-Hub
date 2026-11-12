import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { parseEnv, promisify } from "node:util";
import { getTestComposeArguments } from "./test-compose.ts";
import { signInTestAdministrator, signInTestUser } from "./test-keycloak.ts";

type ComposeService = { environment: Record<string, string> };
type ComposeConfig = { services: Record<string, ComposeService> };

const controller = new AbortController();
const { signal } = controller;
const capture = promisify(execFile);

const run = (command: string, args: string[], env: NodeJS.ProcessEnv, runSignal?: AbortSignal) => new Promise<void>((resolve, reject) => {

	const child = spawn(command, args, { env, signal: runSignal, stdio: "inherit" });
	let error: Error | undefined;
	child.once("error", (cause) => { error = cause; });
	child.once("close", (code, stoppedBy) => {

		if(code === 0 && !error) {
			resolve();
		} else {
			reject(error ?? new Error(`${command} exited with ${code ?? stoppedBy}`));
		}

	});

});

const runVitest = (env: NodeJS.ProcessEnv, config?: string) => {
	const configArguments = config ? ["--config", config] : [];

	return run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...configArguments], env, signal);
};

const getKeycloakPort = async () => {

	const server = createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address() as AddressInfo;
	server.close();
	await once(server, "close");

	return port;

};

const usePublishedAddress = (connectionUrl: string, address: string) => {
	const url = new URL(connectionUrl);
	url.host = address;

	return url.href;
};

const getHttpEnvironment = async (issuer: string, apiUrl: string, setupUrl: string, redisUrl: string) => {

	const [administrator, foreignAdministrator, reception, professional, platform] = await Promise.all(
		["clinic-administrator", "clinic-administrator-2", "reception", "healthcare-professional", "platform-administrator"]
			.map((username) => signInTestUser(issuer, username, signal)),
	);
	const roles = {
		ADMIN: administrator.access_token,
		RECEPTION: reception.access_token,
		PROFESSIONAL: professional.access_token,
		PLATFORM: platform.access_token,
	};
	const env: NodeJS.ProcessEnv = {};
	for(const prefix of ["APPOINTMENT", "APPOINTMENT_QUERY", "AVAILABILITY", "PATIENT", "SCHEDULE"]) {

		env[prefix+"_TEST_API_URL"] = apiUrl;
		env[prefix+"_TEST_DATABASE_SETUP_URL"] = setupUrl;
		for(const [role, token] of Object.entries(roles)) {
			env[`${prefix}_TEST_${role}_TOKEN`] = token;
		}

	}

	return {
		...env,
		AUDIT_TEST_API_URL: apiUrl,
		AUDIT_TEST_ADMIN_TOKEN: roles.ADMIN,
		AUDIT_TEST_FOREIGN_ADMIN_TOKEN: foreignAdministrator.access_token,
		AUDIT_TEST_RECEPTION_TOKEN: roles.RECEPTION,
		AVAILABILITY_TEST_REDIS_URL: redisUrl,
		CLINICAL_NOTE_TEST_API_URL: apiUrl,
		CLINICAL_NOTE_TEST_DATABASE_SETUP_URL: setupUrl,
		CLINICAL_NOTE_TEST_PROFESSIONAL_TOKEN: roles.PROFESSIONAL,
		CLINICAL_NOTE_TEST_RECEPTION_TOKEN: roles.RECEPTION,
		CLINIC_TEST_API_URL: apiUrl,
		CLINIC_TEST_DATABASE_SETUP_URL: setupUrl,
		CLINIC_TEST_PLATFORM_TOKEN: roles.PLATFORM,
		CLINIC_TEST_RECEPTION_TOKEN: roles.RECEPTION,
		PATIENT_TEST_FOREIGN_ADMIN_TOKEN: foreignAdministrator.access_token,
		USER_TEST_CLINIC_ADMIN_TOKEN: roles.ADMIN,
		USER_TEST_PROFESSIONAL_TOKEN: roles.PROFESSIONAL,
	};

};

const runComposeTests = async () => {

	const project = "mdh-test-"+randomUUID();
	const composeArguments = getTestComposeArguments(project);
	const keycloakPort = await getKeycloakPort();
	const keycloakUrl = `http://localhost:${keycloakPort}`;
	const issuer = keycloakUrl+"/realms/medical-data-hub";
	const composeEnv = { ...process.env };
	for(const key of Object.keys(parseEnv(readFileSync(".env.example", "utf8")))) {
		delete composeEnv[key];
	}
	Object.assign(composeEnv, {
		KC_HOSTNAME: keycloakUrl, KEYCLOAK_ISSUER: issuer, KEYCLOAK_TEST_PORT: String(keycloakPort),
	});

	const readCompose = async (...args: string[]) => {
		const { stdout } = await capture("docker", [...composeArguments, ...args], { env: composeEnv, signal });

		return stdout.trim();
	};
	const { services } = JSON.parse(await readCompose("config", "--format", "json")) as ComposeConfig;
	const apiConfig = services.api.environment;
	const setupConfig = services["database-init"].environment;
	const keycloakConfig = services.keycloak.environment;

	try {

		console.log(`Starting Compose project ${project}`);
		await run("docker", [...composeArguments, "up", "--build", "--wait", "--wait-timeout", "180"], composeEnv, signal);
		const [apiAddress, postgresAddress, redisAddress] = await Promise.all([
			readCompose("port", "api", apiConfig.PORT),
			readCompose("port", "postgres", "5432"),
			readCompose("port", "redis", "6379"),
		]);
		const setupUrl = usePublishedAddress(setupConfig.DATABASE_URL, postgresAddress);
		const databaseEnv = {
			...composeEnv,
			DATABASE_SETUP_URL: setupUrl,
			DATABASE_URL: usePublishedAddress(apiConfig.DATABASE_URL, postgresAddress),
		};
		console.log("Running PostgreSQL integration tests");
		await runVitest(databaseEnv, "vitest-database.config.ts");

		const httpEnv = await getHttpEnvironment(issuer, "http://"+apiAddress, setupUrl, "redis://"+redisAddress);
		const adminToken = await signInTestAdministrator(
			keycloakUrl, keycloakConfig.KC_BOOTSTRAP_ADMIN_USERNAME, keycloakConfig.KC_BOOTSTRAP_ADMIN_PASSWORD, signal,
		);
		console.log("Running API integration tests");
		await runVitest({
			...databaseEnv,
			...httpEnv,
			CLINIC_TEST_KEYCLOAK_URL: keycloakUrl,
			CLINIC_TEST_KEYCLOAK_ADMIN_TOKEN: adminToken,
			KEYCLOAK_CLIENT_ID: apiConfig.KEYCLOAK_CLIENT_ID,
			KEYCLOAK_CLIENT_SECRET: apiConfig.KEYCLOAK_CLIENT_SECRET,
		}, "vitest-http.config.ts");

		const [access, logout, other] = await Promise.all(
			Array.from({ length: 3 }, () => signInTestUser(issuer, "reception", signal)),
		);
		console.log("Running Keycloak integration tests");
		await runVitest({
			...composeEnv,
			KEYCLOAK_TEST_COMPOSE_PROJECT: project,
			KEYCLOAK_TEST_ISSUER: issuer,
			KEYCLOAK_TEST_ACCESS_TOKEN: access.access_token,
			KEYCLOAK_LOGOUT_REFRESH_TOKEN: logout.refresh_token,
			KEYCLOAK_OTHER_REFRESH_TOKEN: other.refresh_token,
		}, "vitest-auth.config.ts");

	} finally {
		await run("docker", [...composeArguments, "down", "--volumes", "--rmi", "local"], composeEnv);
	}

};

const main = async () => {

	if(!existsSync("node_modules")) {

		const npm = process.env.npm_execpath;
		if(!npm) {
			throw new Error("Use npm run test:all to install dependencies and run the tests");
		}
		await run(process.execPath, [npm, "ci"], process.env, signal);

	}
	await run(process.execPath, ["node_modules/prisma/build/index.js", "generate", "--config", "apps/api/prisma7.config.ts"], process.env, signal);
	console.log("Running unit tests");
	await runVitest(process.env);
	await runComposeTests();

};

const interrupt = () => controller.abort();
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
try {
	await main();
} catch(error) {
	console.error(signal.aborted ? "Test execution interrupted" : error instanceof Error ? error.message : error);
	process.exitCode = 1;
} finally {
	process.off("SIGINT", interrupt);
	process.off("SIGTERM", interrupt);
}
