import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import type { QueryResult } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createPatient, updatePatient } from "../../src/database/patients.js";
import type { Patient, User } from "../../src/generated/prisma/client.js";
import { UserRole } from "../../src/generated/prisma/enums.js";

const setupUrl = process.env.DATABASE_SETUP_URL;
const apiUrl = process.env.DATABASE_URL;
if(!setupUrl || !apiUrl) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupUrl });
const pool = new Pool({ connectionString: apiUrl, max: 1 });
const registration = { name: "Synthetic commit test patient", dateOfBirth: "1990-05-15", email: "commit@example.test", phone: null };
let actor: Pick<User, "identityId" | "clinicId">;

beforeAll(async () => {

	await setup.connect();
	const { rows } = await setup.query<typeof actor>(
		`SELECT identity_id AS "identityId", clinic_id AS "clinicId" FROM public.users
		 WHERE role = 'reception' AND is_active ORDER BY user_id LIMIT 1`,
	);
	[actor] = rows;

});

afterAll(async () => {
	await pool.end();
	await setup.end();
});

it("withholds patient registration success until the patient and audit event commit", async () => {

	const identification = randomUUID();
	const connection = await pool.connect();
	const query = connection.query.bind(connection);
	const commitGate = Promise.withResolvers<void>();
	const commitReady = Promise.withResolvers<void>();
	const interceptedQuery = vi.spyOn(connection, "query").mockImplementation((...args: unknown[]) => {

		if(args[0] === "COMMIT") {
			commitReady.resolve();

			return commitGate.promise.then(() => query("COMMIT"));
		}

		return Reflect.apply(query, connection, args);

	});
	connection.release();
	let delivered = false;
	const operation = createPatient(
		{ identityId: actor.identityId, roles: [UserRole.reception] },
		{ ...registration, identification },
		pool,
	).then(() => {
		delivered = true;
	});

	try {

		await commitReady.promise;
		expect(delivered).toBe(false);
		expect((await setup.query("SELECT 1 FROM public.patients WHERE identification = $1", [identification])).rows).toEqual([]);
		commitGate.resolve();
		await operation;
		expect(delivered).toBe(true);

	} finally {

		commitGate.resolve();
		await operation;
		interceptedQuery.mockRestore();

	}

});

it("withholds patient registration success without retry when commit confirmation is lost", async () => {

	const identification = randomUUID();
	const connection = await pool.connect();
	const query = connection.query.bind(connection);
	const lostConfirmation = new Error("Synthetic loss of patient commit confirmation");
	const interceptedQuery = vi.spyOn(connection, "query").mockImplementation((...args: unknown[]) => {

		if(args[0] === "COMMIT") {
			return query("COMMIT").then(() => {
				throw lostConfirmation;
			});
		}

		return Reflect.apply(query, connection, args);

	});
	connection.release();

	try {

		await expect(createPatient(
			{ identityId: actor.identityId, roles: [UserRole.reception] },
			{ ...registration, identification },
			pool,
		)).rejects.toMatchObject({ stage: "commit", kind: "indeterminateCommit", cause: lostConfirmation });
		expect(interceptedQuery.mock.calls.filter(([statement]) => statement === "COMMIT")).toHaveLength(1);
		const { rows } = await setup.query(
			`SELECT event.action FROM public.patients AS patient
			 JOIN public.audit_records AS event USING (clinic_id, patient_id)
			 WHERE patient.clinic_id = $1::uuid AND patient.identification = $2`,
			[actor.clinicId, identification],
		);
		expect(rows).toEqual([{ action: "write" }]);

	} finally {
		interceptedQuery.mockRestore();
	}

});

it.each(["FOR UPDATE", "FOR NO KEY UPDATE"])("takes %s before returning patient contact data", async (lock) => {

	const { rows: [patient] } = await setup.query<Pick<Patient, "patientId" | "identification">>(
		`INSERT INTO public.patients (clinic_id, identification, name, date_of_birth, email)
		 VALUES ($1, $2, $3, $4::date, $5) RETURNING patient_id AS "patientId", identification`,
		[actor.clinicId, randomUUID(), registration.name, registration.dateOfBirth, registration.email],
	);
	const connection = await pool.connect();
	const query = connection.query.bind(connection);
	const readReady = Promise.withResolvers<void>();
	const readGate = Promise.withResolvers<void>();
	const interceptedQuery = vi.spyOn(connection, "query").mockImplementation((...args: unknown[]) => {

		return Reflect.apply(query, connection, args).then(async (result: QueryResult) => {

			if(result.fields.some(({ name }) => name === "email")) {
				readReady.resolve();
				await readGate.promise;
			}

			return result;

		});

	});
	connection.release();
	const changes = lock === "FOR UPDATE" ? { identification: patient.identification } : { name: "Updated synthetic patient" };
	const operation = updatePatient({ identityId: actor.identityId, roles: [UserRole.reception] }, patient.patientId, changes, pool);

	try {

		await readReady.promise;
		await setup.query("BEGIN");
		const keyShare = setup.query("SELECT patient_id FROM public.patients WHERE patient_id = $1 FOR KEY SHARE NOWAIT", [patient.patientId]);
		if(lock === "FOR UPDATE") {
			await expect(keyShare).rejects.toMatchObject({ code: "55P03" });
		} else {

			expect((await keyShare).rows).toEqual([{ patient_id: patient.patientId }]);
			await setup.query("ROLLBACK");
			await setup.query("BEGIN");
			await expect(setup.query("SELECT patient_id FROM public.patients WHERE patient_id = $1 FOR SHARE NOWAIT", [patient.patientId]))
				.rejects.toMatchObject({ code: "55P03" });

		}
		await setup.query("ROLLBACK");
		readGate.resolve();
		await expect(operation).resolves.toEqual({ patientId: patient.patientId, updated: true });

	} finally {

		await setup.query("ROLLBACK");
		readGate.resolve();
		await operation;
		interceptedQuery.mockRestore();

	}

});
