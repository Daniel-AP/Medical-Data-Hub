import { execFile } from "node:child_process";
import { once } from "node:events";
import { STATUS_CODES } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import type { RequestHandler } from "express";
import { decodeJwt } from "jose";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { app, router } from "../../src/app.js";
import { createAccessTokenVerifier } from "../../src/clients/keycloak.js";
import { UserRole } from "../../src/generated/prisma/enums.js";
import { createAuthenticationMiddleware, requireRoles } from "../../src/middleware/authentication.js";

const accessToken = process.env.KEYCLOAK_TEST_ACCESS_TOKEN;
if (!accessToken) {
	throw new Error("Set KEYCLOAK_TEST_ACCESS_TOKEN to a fresh reception access token");
}

const issuer = "http://localhost:8080/realms/medical-data-hub";
const configuration = { issuer, audience: "medical-data-hub-api", jwksUrl: `${issuer}/protocol/openid-connect/certs` };
const requestOptions = { headers: { Authorization: `Bearer ${accessToken}` } };
const execFileAsync = promisify(execFile);
const composeArguments = ["compose", "--project-name", "mdh-auth-tests", "--env-file", ".env.example"];
const sendNoContent: RequestHandler = (_request, response) => {
	response.sendStatus(204);
};
let server: Server;
let url: string;

beforeAll(async () => {
	const authenticate = createAuthenticationMiddleware(createAccessTokenVerifier(configuration));
	router.get("/authentication-check", authenticate, (request, response) => {
		response.json(request.authentication);
	});
	router.get(
		"/role-check",
		authenticate,
		requireRoles(UserRole.clinicAdministrator, UserRole.reception),
		sendNoContent,
	);
	router.get("/clinic-administrator-check", authenticate, requireRoles(UserRole.clinicAdministrator), sendNoContent);
	router.get(
		"/wrong-issuer-check",
		createAuthenticationMiddleware(
			createAccessTokenVerifier({ ...configuration, issuer: "http://localhost:8080/realms/another-realm" }),
		),
		sendNoContent,
	);
	router.get(
		"/wrong-audience-check",
		createAuthenticationMiddleware(createAccessTokenVerifier({ ...configuration, audience: "another-api" })),
		sendNoContent,
	);
	router.get(
		"/cold-start-check",
		createAuthenticationMiddleware(createAccessTokenVerifier(configuration)),
		sendNoContent,
	);

	server = app.listen(0, "127.0.0.1");
	await once(server, "listening");
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	await createAccessTokenVerifier(configuration)(accessToken);
});

afterAll(async () => {
	server.close();
	await once(server, "close");
});

it("accepts a real Keycloak token and returns the reception identity", async () => {
	const response = await fetch(`${url}/authentication-check`, requestOptions);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ identityId: expect.any(String), roles: [UserRole.reception] });
});

it("rejects a missing bearer token with 401 in the real-provider fixture", async () => {
	const response = await fetch(`${url}/authentication-check`);
	expect(response.status).toBe(401);
});

it("rejects a malformed token with 401 in the real-provider fixture", async () => {
	const response = await fetch(`${url}/authentication-check`, { headers: { Authorization: "Bearer invalid-token" } });
	expect(response.status).toBe(401);
});

it("rejects a modified signature against real Keycloak keys with 401", async () => {
	const [header, payload, signature] = accessToken.split(".");
	const modifiedSignature = (signature[0] === "A" ? "B" : "A") + signature.slice(1);
	const response = await fetch(`${url}/authentication-check`, {
		headers: { Authorization: `Bearer ${header}.${payload}.${modifiedSignature}` },
	});
	expect(response.status).toBe(401);
});

it("accepts a permitted role from a real Keycloak token", async () => {
	const response = await fetch(`${url}/role-check`, requestOptions);
	expect(response.status).toBe(204);
});

it("rejects an insufficient role from a real Keycloak token with 403", async () => {
	const response = await fetch(`${url}/clinic-administrator-check`, requestOptions);
	expect(response.status).toBe(403);
});

it("rejects an issuer mismatch for a real Keycloak token with 401", async () => {
	const response = await fetch(`${url}/wrong-issuer-check`, requestOptions);
	expect(response.status).toBe(401);
});

it("rejects an audience mismatch for a real Keycloak token with 401", async () => {
	const response = await fetch(`${url}/wrong-audience-check`, requestOptions);
	expect(response.status).toBe(401);
});

it("rejects a real Keycloak token after expiration with a simulated clock", async () => {
	const { exp } = decodeJwt(accessToken);
	if (typeof exp !== "number") {
		throw new Error("The test token must contain a numeric expiration");
	}

	vi.useFakeTimers({ toFake: ["Date"] });
	try {
		vi.setSystemTime((exp + 1) * 1000);
		const response = await fetch(`${url}/authentication-check`, requestOptions);
		expect(response.status).toBe(401);
	} finally {
		vi.useRealTimers();
	}
});

it("uses cached keys during a Keycloak outage and recovers cold verification", async () => {
	const warmResponse = await fetch(`${url}/authentication-check`, requestOptions);
	expect(warmResponse.status).toBe(200);

	try {
		await execFileAsync("docker", [...composeArguments, "stop", "keycloak"], { timeout: 30_000 });
		const cachedResponse = await fetch(`${url}/authentication-check`, requestOptions);
		expect(cachedResponse.status).toBe(200);

		const coldResponse = await fetch(`${url}/cold-start-check`, requestOptions);
		expect(coldResponse.status).toBe(503);
		expect(await coldResponse.json()).toEqual({ error: STATUS_CODES[503] });
	} finally {
		await execFileAsync("docker", [...composeArguments, "up", "--wait", "--wait-timeout", "180", "keycloak"], {
			timeout: 190_000,
		});
	}

	const recoveredResponse = await fetch(`${url}/cold-start-check`, requestOptions);
	expect(recoveredResponse.status).toBe(204);
}, 300_000);
