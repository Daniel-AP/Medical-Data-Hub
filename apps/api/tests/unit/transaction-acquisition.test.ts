import { Client, Pool } from "pg";
import type { PoolClient } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { databaseTimeouts } from "../../src/config/database-timeouts.js";
import { runTransaction } from "../../src/database/transaction.js";

afterEach(() => {
	vi.useRealTimers();
});

it("releases a late checkout without starting a database transaction", async () => {
	vi.useFakeTimers();
	const checkout = Promise.withResolvers<PoolClient>();
	const pool = new Pool();
	vi.spyOn(pool, "connect").mockImplementation(() => checkout.promise);
	const client = Object.assign(new Client(), { release: vi.fn() });
	const query = vi.spyOn(client, "query");
	const operation = vi.fn(async () => undefined);
	const result = runTransaction("readCommitted", operation, pool);
	const rejected = expect(result).rejects.toMatchObject({ stage: "acquire", kind: "acquireTimeout" });

	await vi.advanceTimersByTimeAsync(databaseTimeouts.acquireMs);
	await rejected;
	checkout.resolve(client);
	await vi.advanceTimersByTimeAsync(0);

	expect(client.release).toHaveBeenCalledTimes(1);
	expect(query).not.toHaveBeenCalled();
	expect(operation).not.toHaveBeenCalled();
});
