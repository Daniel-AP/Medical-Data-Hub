import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = new URL("../../", import.meta.url);
const output = new URL(".vitest/index-evaluation/output/", root);
const results = new URL("performance/indexes/", root);
const settings = parseEnv(readFileSync(new URL(".env.example", root), "utf8"));
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !(name.toUpperCase() in settings)));
const scriptsVolume = `${import.meta.dirname}:/app/scripts/index-evaluation:ro`;

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
		"run", "--rm", "--no-deps", "--volume", scriptsVolume,
		"database-init", "node", "--import", "tsx", "/app/scripts/index-evaluation/seed-index-evaluation.ts",
	]);
	runCompose([
		"run", "--rm", "--no-deps", "--volume", scriptsVolume,
		"--volume", `${fileURLToPath(output)}:/app/performance/indexes`,
		"database-init", "node", "--import", "tsx", "/app/scripts/index-evaluation/measure-index-evaluation.ts",
	]);

} finally {
	runCompose(["down", "--volumes"]);
}

cpSync(output, results, { recursive: true });
console.log("Results saved");
