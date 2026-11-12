import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { readPatient } from "../../src/database/patients.js";
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

const createPatientFixture = async () => {

	const { rows: [patient] } = await setup.query<Pick<Patient, "patientId" | "identification">>(
		`INSERT INTO public.patients (clinic_id, identification, name, date_of_birth, email)
		 VALUES ($1, $2, $3, $4::date, $5) RETURNING patient_id AS "patientId", identification`,
		[actor.clinicId, randomUUID(), registration.name, registration.dateOfBirth, registration.email],
	);

	return patient;

};

it("withholds patient contact data until its read event commits", async () => {

	const patient = await createPatientFixture();
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
	const operation = readPatient({ identityId: actor.identityId, roles: [UserRole.reception] }, patient.patientId, pool).then((record) => {
		delivered = true;

		return record;
	});

	try {

		await commitReady.promise;
		expect(delivered).toBe(false);
		const auditQuery = "SELECT action FROM public.audit_records WHERE patient_id = $1";
		expect((await setup.query(auditQuery, [patient.patientId])).rows).toEqual([]);
		commitGate.resolve();
		expect(await operation).toEqual({ ...registration, ...patient });
		expect((await setup.query(auditQuery, [patient.patientId])).rows).toEqual([{ action: "read" }]);

	} finally {

		commitGate.resolve();
		await operation;
		interceptedQuery.mockRestore();

	}

});
