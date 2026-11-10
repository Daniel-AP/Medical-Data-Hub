import { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { runTransaction } from "../../src/database/transaction.js";

it("does not run the operation when the pool rejects acquisition", async () => {

	const pool = new Pool();
	await pool.end();
	const operation = vi.fn(async () => undefined);

	await expect(runTransaction("readCommitted", operation, pool)).rejects.toMatchObject({
		stage: "acquire",
		kind: "acquisition",
	});
	expect(operation).not.toHaveBeenCalled();

});
