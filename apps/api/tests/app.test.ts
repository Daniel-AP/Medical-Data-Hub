import { once } from "node:events";
import { STATUS_CODES } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { app, router } from "../src/app.js";

let server: Server;
let url: string;
const requestOptions = { method: "POST", headers: { "Content-Type": "application/json" } };

beforeAll(async () => {
	router.post("/runtime-json-check", (request, response) => {
		response.json(request.body);
	});
	router.get("/runtime-error-check", async () => {
		throw new Error("Synthetic internal detail");
	});

	server = app.listen(0, "127.0.0.1");
	await once(server, "listening");
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	server.close();
	await once(server, "close");
});

it("rejects malformed JSON and parses a later request", async () => {
	const invalidResponse = await fetch(`${url}/runtime-json-check`, { ...requestOptions, body: '{"value":' });
	expect(invalidResponse.status).toBe(400);
	expect(await invalidResponse.json()).toEqual({ error: "Invalid JSON" });

	const validResponse = await fetch(`${url}/runtime-json-check`, {
		...requestOptions,
		body: '{"value":"synthetic"}',
	});
	expect(validResponse.status).toBe(200);
	expect(await validResponse.json()).toEqual({ value: "synthetic" });
});

it("returns a generic JSON response for unknown routes", async () => {
	const response = await fetch(`${url}/unknown-route`);
	expect(response.status).toBe(404);
	expect(await response.json()).toEqual({ error: "Route not found" });
});

it("returns a generic JSON response for unexpected errors and remains usable", async () => {
	const errorResponse = await fetch(`${url}/runtime-error-check`);
	expect(errorResponse.status).toBe(500);
	expect(await errorResponse.json()).toEqual({ error: STATUS_CODES[500] });

	const validResponse = await fetch(`${url}/runtime-json-check`, {
		...requestOptions,
		body: '{"value":"synthetic"}',
	});
	expect(validResponse.status).toBe(200);
	expect(await validResponse.json()).toEqual({ value: "synthetic" });
});

it("preserves the payload size error status", async () => {
	const response = await fetch(`${url}/runtime-json-check`, {
		...requestOptions,
		body: JSON.stringify({ value: "x".repeat(101 * 1024) }),
	});
	expect(response.status).toBe(413);
	expect(await response.json()).toEqual({ error: STATUS_CODES[413] });
});
