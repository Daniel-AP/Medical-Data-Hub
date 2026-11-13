import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { parseEnv } from "node:util";

export const getTestComposeArguments = (project: string) => [
	"compose", "--project-name", project, "--env-file", ".env.example",
	"-f", "docker-compose.yml", "-f", "infra/testing/compose.yml",
];

export const getTestComposeEnvironment = async () => {

	const server = createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address() as AddressInfo;
	server.close();
	await once(server, "close");

	const keycloakUrl = `http://localhost:${port}`;
	const issuer = keycloakUrl+"/realms/medical-data-hub";
	const env = { ...process.env };
	for(const key of Object.keys(parseEnv(readFileSync(".env.example", "utf8")))) {
		delete env[key];
	}
	Object.assign(env, { KC_HOSTNAME: keycloakUrl, KEYCLOAK_ISSUER: issuer, KEYCLOAK_TEST_PORT: String(port) });

	return { env, issuer, keycloakUrl };

};

export const usePublishedAddress = (connectionUrl: string, address: string) => {
	const url = new URL(connectionUrl);
	url.host = address;

	return url.href;
};
