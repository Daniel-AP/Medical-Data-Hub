import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { promisify } from "node:util";
import { decodeJwt } from "jose";
import { Pool } from "pg";
import { getTestComposeArguments, getTestComposeEnvironment, usePublishedAddress } from "../test-compose.ts";
import { signInTestUser } from "../test-keycloak.ts";
import { readFixtures, verifyAvailabilityVersion } from "./fixtures.ts";
import { renderReport } from "./report.ts";
import { measureWorkload } from "./samples.ts";

type ComposeConfig = {
	services: Record<string, { environment: Record<string, string>; image: string }>;
};

const capture = promisify(execFile);
const controller = new AbortController();
const { signal } = controller;
const startedAt = new Date().toISOString();
const sourcePaths = [".dockerignore", ".env.example", "apps/api", "docker-compose.yml", "infra", "package.json", "package-lock.json", "scripts"];
const timeoutNames = [
	"DATABASE_ACQUIRE_TIMEOUT_MS", "DATABASE_LOCK_TIMEOUT_MS", "DATABASE_STATEMENT_TIMEOUT_MS",
	"KEYCLOAK_HTTP_TIMEOUT_MS", "REDIS_BATCH_TIMEOUT_MS",
];

const readSource = async () => {

	const [{ stdout: revision }, { stdout: status }, { stdout: files }] = await Promise.all([
		capture("git", ["rev-parse", "HEAD"], { signal }),
		capture("git", ["status", "--porcelain", "--untracked-files=all", "--no-renames", "--", ...sourcePaths], { signal }),
		capture("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...sourcePaths], { signal }),
	]);
	const sourceFiles = files.split("\0").filter(Boolean).sort();
	const changes = status.trimEnd().split("\n").filter(Boolean);
	const deleted = new Set(changes.filter((line) => line.slice(0, 2).includes("D")).map((line) => line.slice(3)));
	const hash = createHash("sha256");
	for(const file of sourceFiles) {
		if(!deleted.has(file)) {
			const fileHash = createHash("sha256").update(readFileSync(file)).digest("hex");
			hash.update(file+"\0"+fileHash+"\n");
		}
	}

	return { revision: revision.trim(), sourceChanges: changes.map((line) => line.slice(3)), sourceHash: hash.digest("hex") };

};

const runDocker = (args: string[], env: NodeJS.ProcessEnv, operation: string, runSignal?: AbortSignal) => new Promise<void>((resolve, reject) => {

	const child = spawn("docker", args, { env, signal: runSignal, stdio: ["ignore", process.stderr, "inherit"] });
	child.once("error", () => reject(new Error(operation+" failed to start")));
	child.once("close", (code) => {
		if(code === 0) {
			resolve();
		} else {
			reject(new Error(operation+" failed"));
		}
	});

});

const run = async () => {

	const source = await readSource();
	const project = "mdh-cache-"+randomUUID();
	const compose = [...getTestComposeArguments(project), "-f", "infra/measurement/compose.yml"];
	const { env, issuer } = await getTestComposeEnvironment();
	const readDocker = async (operation: string, ...args: string[]) => {

		try {
			const { stdout } = await capture("docker", args, { env, signal });

			return stdout.trim();
		} catch {
			throw new Error(operation+" failed");
		}

	};
	const { services } = JSON.parse(await readDocker("Reading Compose configuration", ...compose, "config", "--format", "json")) as ComposeConfig;
	const timeouts = Object.fromEntries(timeoutNames.map((name) => [name, services.api.environment[name]]));

	let database: Pool | undefined;
	let step = "Starting Compose";
	try {

		console.error("Starting isolated Compose project "+project);
		await runDocker([...compose, "up", "--build", "--wait", "--wait-timeout", "180"], env, step, signal);
		step = "Reading service addresses and versions";
		const [apiAddress, postgresAddress, engineVersion, composeVersion, apiNodeVersion, keycloakVersion, redisVersion] = await Promise.all([
			readDocker(step, ...compose, "port", "api", services.api.environment.PORT),
			readDocker(step, ...compose, "port", "postgres", "5432"),
			readDocker(step, "version", "--format", "{{.Server.Version}}"),
			readDocker(step, "compose", "version", "--short"),
			readDocker(step, ...compose, "exec", "-T", "api", "node", "--version"),
			readDocker(step, ...compose, "exec", "-T", "keycloak", "/opt/keycloak/bin/kc.sh", "--version"),
			readDocker(step, ...compose, "exec", "-T", "redis", "redis-server", "--version"),
		]);
		const apiUrl = "http://"+apiAddress;
		const setupUrl = usePublishedAddress(services["database-init"].environment.DATABASE_URL, postgresAddress);
		database = new Pool({ connectionString: setupUrl, connectionTimeoutMillis: 5_000 });
		step = "Signing in as reception";
		const { access_token: token } = await signInTestUser(issuer, "reception", signal);
		const { sub } = decodeJwt(token);
		if(!sub) {
			throw new Error("The reception token has no subject");
		}

		step = "Reading seed fixtures and indexes";
		const fixtures = await readFixtures(database, sub);
		const { serviceId, professionalId } = fixtures.scope;
		const workloads = [];
		for(const workload of [
			{ name: "CW1", url: new URL(`/professionals/${professionalId}/availability?serviceId=${serviceId}&date=${fixtures.from}`, apiUrl), expectedUnits: 1 },
			{ name: "CW2", url: new URL(`/services/${serviceId}/availability?from=${fixtures.from}&to=${fixtures.to}`, apiUrl), expectedUnits: 7*fixtures.professionalIds.length },
		]) {
			step = "Measuring "+workload.name;
			console.error(step);
			workloads.push(await measureWorkload(workload, token, signal));
		}

		step = "Verifying the clinic version and source fingerprint";
		await verifyAvailabilityVersion(database, fixtures.scope);
		const finalSource = await readSource();
		if(finalSource.revision !== source.revision || finalSource.sourceHash !== source.sourceHash) {
			throw new Error("The measured source changed during the run");
		}
		const versions = {
			"Runner Node.js": process.version,
			"Docker Engine": engineVersion,
			"Docker Compose": composeVersion,
			"API Node.js": apiNodeVersion,
			PostgreSQL: fixtures.postgresVersion,
			Keycloak: keycloakVersion.split("\n")[0].replace(/^Keycloak\s+/, ""),
			Redis: redisVersion.match(/\bv=([^\s]+)/)?.[1] ?? services.redis.image,
		};
		console.log(renderReport({ ...source, startedAt, host: `${platform()} ${release()} ${arch()}`, versions, timeouts, fixtures, workloads }));
		if(workloads.some(({ pairs }) => pairs.some(({ included }) => !included))) {
			process.exitCode = 1;
		}

	} catch(error) {
		// Driver and process errors may include connection or request details.
		const detail = error instanceof Error && error.message.startsWith("CW") ? " "+error.message : "";
		throw new Error(step+" failed."+detail);
	} finally {
		try {
			await database?.end();
		} finally {
			await runDocker([...compose, "down", "--volumes", "--rmi", "local"], env, "Removing Compose project");
		}
	}

};

const interrupt = () => controller.abort();
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
try {
	await run();
} catch(error) {
	console.error(signal.aborted ? "Cache measurement interrupted" : error instanceof Error ? error.message : "Cache measurement failed");
	process.exitCode = 1;
} finally {
	process.off("SIGINT", interrupt);
	process.off("SIGTERM", interrupt);
}
