import { Client, Pool } from "pg";
import { afterAll, expect, it, vi } from "vitest";
import { databaseTimeouts } from "../../../src/config/database-timeouts.js";
import { runTransaction } from "../../../src/database/transaction.js";
import type { TransactionClient } from "../../../src/database/types.js";

const connectionString = process.env.DATABASE_URL;
if(!connectionString) {
	throw new Error("DATABASE_URL is required for isolated database tests");
}

const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: databaseTimeouts.acquireMs });

afterAll(async () => {
	await pool.end();
});

const readSession = async (client: Pick<Pool, "query">) => {

	const { rows } = await client.query(`
		SELECT pg_catalog.pg_backend_pid() AS pid, current_user AS role,
		       pg_catalog.current_setting('app.user_id', true) AS "userId",
		       pg_catalog.current_setting('app.clinic_id', true) AS "clinicId"
	`);

	return rows[0];

};

const setLocalScope = async (client: Pick<Pool, "query">) => {

	await client.query(`
		SELECT pg_catalog.set_config('app.user_id', pg_catalog.gen_random_uuid()::text, true),
		       pg_catalog.set_config('app.clinic_id', pg_catalog.gen_random_uuid()::text, true)
	`);
	await client.query("SET LOCAL ROLE reception");

};

it("times out a queued phase without disturbing the active transaction context", async () => {

	const callback = vi.fn(async () => undefined);
	const pid = await runTransaction(
		"readCommitted",
		async (client) => {

			await setLocalScope(client);
			const activeSession = await readSession(client);

			await expect(runTransaction("readCommitted", callback, pool)).rejects.toMatchObject({
				stage: "acquire",
				kind: "acquisition",
			});
			expect(pool.waitingCount).toBe(0);
			expect(callback).not.toHaveBeenCalled();
			expect(await readSession(client)).toEqual(activeSession);

			return activeSession.pid;

		},
		pool,
	);

	const nextSession = await runTransaction("readCommitted", readSession, pool);
	expect(nextSession).toEqual({ pid, role: "medical_data_hub_api", userId: "", clinicId: "" });

});

it("returns after commit and reuses the same connection with cleared local context", async () => {

	const { pid } = await readSession(pool);

	const { transactionId, previousClient } = await runTransaction(
		"readCommitted",
		async (client) => {

			expect(await readSession(client)).toEqual({ pid, role: "medical_data_hub_api", userId: "", clinicId: "" });
			const { rows } = await client.query(`
				SELECT pg_catalog.current_setting('transaction_isolation') AS isolation,
				       pg_catalog.current_setting('transaction_read_only') AS "readOnly",
				       pg_catalog.pg_current_xact_id()::text AS "transactionId"
			`);
			expect(rows[0]).toMatchObject({ isolation: "read committed", readOnly: "off" });
			await setLocalScope(client);

			return { transactionId: rows[0].transactionId, previousClient: client };

		},
		pool,
	);

	const { rows } = await pool.query("SELECT pg_catalog.pg_xact_status($1::xid8) AS status", [transactionId]);
	expect(rows[0]).toEqual({ status: "committed" });
	expect(await readSession(pool)).toEqual({ pid, role: "medical_data_hub_api", userId: "", clinicId: "" });

	const nextSession = await runTransaction(
		"readCommitted",
		async (client) => {
			await expect(async () => previousClient.query("SELECT 1")).rejects.toThrow("Transaction attempt is closed");

			return readSession(client);
		},
		pool,
	);
	expect(nextSession).toEqual({ pid, role: "medical_data_hub_api", userId: "", clinicId: "" });

});

it("rolls back a business conflict without retrying and reuses the clean connection", async () => {

	const { pid } = await readSession(pool);
	const conflict = Object.assign(new Error("Operation conflict"), { status: 409 });
	const callback = vi.fn(async (client: TransactionClient) => {

		expect(await readSession(client)).toEqual({ pid, role: "medical_data_hub_api", userId: "", clinicId: "" });
		const { rows } = await client.query("SHOW transaction_isolation");
		expect(rows[0]).toEqual({ transaction_isolation: "repeatable read" });
		await setLocalScope(client);
		throw conflict;

	});

	await expect(runTransaction("repeatableRead", callback, pool)).rejects.toBe(conflict);
	expect(callback).toHaveBeenCalledTimes(1);
	expect(await readSession(pool)).toEqual({ pid, role: "medical_data_hub_api", userId: "", clinicId: "" });

});

it("reports an explicit rollback at commit and discards the provisional result", async () => {

	const { pid } = await readSession(pool);
	await expect(
		runTransaction(
			"readCommitted",
			async (client) => {
				await setLocalScope(client);
				await expect(client.query("SELECT 1 / 0")).rejects.toMatchObject({ code: "22012" });

				return "provisional";
			},
			pool,
		),
	).rejects.toMatchObject({ stage: "commit", kind: "aborted" });

	expect(await readSession(pool)).toEqual({ pid, role: "medical_data_hub_api", userId: "", clinicId: "" });

});

it("rejects an unconfirmed commit and discards the terminated connection", async () => {

	const terminator = new Client({ connectionString });
	await terminator.connect();

	let provisional: { pid: number; transactionId: string } | undefined;
	let discardSignal: unknown;
	const onRelease = (signal: unknown) => {
		discardSignal = signal;
	};
	pool.once("release", onRelease);

	try {

		await expect(
			runTransaction(
				"readCommitted",
				async (client) => {

					const { rows: phase } = await client.query<{ pid: number; transactionId: string }>(`
						SELECT pg_catalog.pg_backend_pid() AS pid,
						       pg_catalog.pg_current_xact_id()::text AS "transactionId"
					`);
					await setLocalScope(client);

					const { rows } = await terminator.query(
						"SELECT pg_catalog.pg_terminate_backend($1::int, 1000) AS terminated",
						[phase[0].pid],
					);
					expect(rows).toEqual([{ terminated: true }]);
					provisional = phase[0];

					return provisional;

				},
				pool,
			),
		).rejects.toMatchObject({ stage: "commit", kind: "indeterminateCommit" });

		expect(provisional).toEqual({ pid: expect.any(Number), transactionId: expect.any(String) });
		expect(discardSignal).toBe(true);
		const { rows } = await terminator.query("SELECT pg_catalog.pg_xact_status($1::xid8) AS status", [
			provisional?.transactionId,
		]);
		expect(rows).toEqual([{ status: "aborted" }]);

		const replacement = await runTransaction("readCommitted", readSession, pool);
		expect(replacement).toEqual({
			pid: expect.any(Number),
			role: "medical_data_hub_api",
			userId: "",
			clinicId: "",
		});
		expect(replacement.pid).not.toBe(provisional?.pid);

	} finally {
		pool.off("release", onRelease);
		await terminator.end();
	}

});

it("reports an indeterminate result without replay when a committed transaction loses its confirmation", async () => {

	const { pid } = await readSession(pool);
	const connection = await pool.connect();
	const query = connection.query.bind(connection);
	const lostConfirmation = new Error("Synthetic loss of commit confirmation");
	const interceptedQuery = vi.spyOn(connection, "query").mockImplementation((...args: unknown[]) => {

		if(args[0] === "COMMIT") {

			return query("COMMIT").then((commit) => {
				expect(commit.command).toBe("COMMIT");
				throw lostConfirmation;
			});

		}

		return Reflect.apply(query, connection, args);

	});
	connection.release();

	let transactionId: string | undefined;
	const callback = vi.fn(async (client: TransactionClient) => {

		const { rows } = await client.query<{ transactionId: string }>(
			'SELECT pg_catalog.pg_current_xact_id()::text AS "transactionId"',
		);
		transactionId = rows[0].transactionId;

		return transactionId;

	});

	try {

		await expect(runTransaction("readCommitted", callback, pool)).rejects.toMatchObject({
			stage: "commit",
			kind: "indeterminateCommit",
			cause: lostConfirmation,
		});
		expect(callback).toHaveBeenCalledTimes(1);

		const { rows } = await pool.query(
			"SELECT pg_catalog.pg_backend_pid() AS pid, pg_catalog.pg_xact_status($1::xid8) AS status",
			[transactionId],
		);
		expect(rows[0]).toEqual({ pid: expect.any(Number), status: "committed" });
		expect(rows[0].pid).not.toBe(pid);

	} finally {
		interceptedQuery.mockRestore();
	}

});
