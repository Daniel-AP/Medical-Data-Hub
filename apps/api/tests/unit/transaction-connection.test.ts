import { Client, Pool } from "pg";
import { expect, it, vi } from "vitest";
import { runTransaction } from "../../src/database/transaction.js";

it("discards a failed connection without attempting rollback", async () => {

	const connectionError = new Error("Synthetic connection failure");
	const client = Object.assign(new Client(), { release: vi.fn() });
	const query = vi.spyOn(client, "query").mockImplementation(async (sql) => {

		if(sql === "SELECT 1") {
			client.emit("error", connectionError);
			throw connectionError;
		}

		return { command: "ROLLBACK", rows: [], rowCount: null, oid: 0, fields: [] };

	});
	const pool = new Pool();
	vi.spyOn(pool, "connect").mockImplementation(async () => client);

	await expect(runTransaction("readCommitted", (client) => client.query("SELECT 1"), pool)).rejects.toMatchObject({
		stage: "operation",
		kind: "connection",
		cause: connectionError,
	});
	await pool.end();

	expect(query).not.toHaveBeenCalledWith("ROLLBACK");
	expect(client.release).toHaveBeenCalledExactlyOnceWith(true);

});
