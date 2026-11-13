import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = new URL("../../../.vitest/index-evaluation/output/", import.meta.url);
const results = new URL("../../../performance/indexes/", import.meta.url);
const settings = parseEnv(readFileSync(new URL("../../../.env.example", import.meta.url), "utf8"));
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !(name.toUpperCase() in settings)));

const runCompose = (args: string[]) => {

	const result = spawnSync("docker", [
		"compose", "--project-name", "postgres-index-evaluation",
		"--file", "docker-compose.yml", "--env-file", ".env.example", ...args,
	], { cwd: root, env: environment, stdio: "inherit" });
	if(result.error) {
		throw result.error;
	}
	if(result.status !== 0) {
		throw new Error(`Docker Compose exited with code ${result.status}`);
	}

};

try {

	rmSync(output, { recursive: true, force: true });
	mkdirSync(output, { recursive: true });
	runCompose(["up", "--detach", "--wait", "postgres"]);
	runCompose(["run", "--rm", "--build", "--no-deps", "database-init"]);
	console.log("Database ready");
	runCompose([
		"run", "--rm", "--no-deps", "--volume",
		`${fileURLToPath(new URL("./", import.meta.url))}:/app/apps/api/scripts:ro`,
		"database-init", "node", "--import", "tsx", "scripts/seed-index-evaluation.ts",
	]);
	runCompose([
		"run", "--rm", "--no-deps", "--volume",
		`${fileURLToPath(new URL("./", import.meta.url))}:/app/apps/api/scripts:ro`,
		"--volume", `${fileURLToPath(output)}:/app/performance/indexes`,
		"database-init", "node", "--import", "tsx", "scripts/measure-index-evaluation.ts",
	]);

} finally {
	runCompose(["down", "--volumes"]);
}

cpSync(output, results, { recursive: true });
console.log("Results saved");
