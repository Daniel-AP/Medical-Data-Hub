import { once } from "node:events";
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
