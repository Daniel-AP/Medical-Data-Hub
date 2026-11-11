import { randomUUID } from "node:crypto";
import { decodeJwt } from "jose";
import { Client, Pool } from "pg";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const apiUrl = process.env.SCHEDULE_TEST_API_URL;
const setupUrl = process.env.SCHEDULE_TEST_DATABASE_SETUP_URL;
const administratorToken = process.env.SCHEDULE_TEST_ADMIN_TOKEN;
const professionalToken = process.env.SCHEDULE_TEST_PROFESSIONAL_TOKEN;
const receptionToken = process.env.SCHEDULE_TEST_RECEPTION_TOKEN;
const platformToken = process.env.SCHEDULE_TEST_PLATFORM_TOKEN;
if(!apiUrl || !setupUrl || !administratorToken || !professionalToken || !receptionToken || !platformToken) {
	throw new Error("Configure the schedule test API, disposable database, and Keycloak tokens");
}

const setup = new Pool({ connectionString: setupUrl });
const professionalId = randomUUID();
const userId = randomUUID();
const blockRegistration = { startAt: "2000-01-07T08:00:00.123-06:00", endAt: "2000-01-07T14:00:00.124Z" };
let clinic: { clinicId: string; specialtyId: string; serviceId: string; patientId: string; durationMinutes: number };
let own: { professionalId: string; userId: string };
let foreignProfessionalId: string;
let receptionUserId: string;

const replaceWeek = (body: unknown, token = administratorToken, targetId: string = professionalId) => {

	return fetch(new URL(`/professionals/${targetId}/schedules`, apiUrl), {
		method: "PUT",
		headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(body),
	});

};

const getWeek = (targetId: string = professionalId, token = receptionToken, query = "") => {
	const url = new URL(`/professionals/${targetId}/schedules`, apiUrl);
	url.search = query;

	return fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
};

const getBlocks = (targetId: string = professionalId, token = receptionToken, query = "") => {
	const url = new URL(`/professionals/${targetId}/blocks`, apiUrl);
	url.search = query;

	return fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
};

const registerBlock = (body: unknown, token = administratorToken, targetId: string = professionalId) => {

	return fetch(new URL(`/professionals/${targetId}/blocks`, apiUrl), {
		method: "POST",
		headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(body),
	});

};

const readBlocks = async () => {

	const { rows } = await setup.query(
		`SELECT professional_block_id AS "professionalBlockId", start_at AS "startAt", end_at AS "endAt"
		 FROM public.professional_blocks WHERE professional_id = $1 ORDER BY start_at, professional_block_id`,
		[professionalId],
	);

	return rows;

};

const createFullWeek = () => setup.query(
	`INSERT INTO public.professional_schedules (clinic_id, professional_id, weekday, start_minute, end_minute)
	 SELECT $1::uuid, $2::uuid, weekday, 0, 1440 FROM generate_series(1, 7) AS weekday`,
	[clinic.clinicId, professionalId],
);

const readWeek = async (targetId: string = professionalId) => {

	const { rows } = await setup.query(
		`SELECT weekday, start_minute AS "startMinute", end_minute AS "endMinute"
		 FROM public.professional_schedules WHERE professional_id = $1 ORDER BY weekday, start_minute, end_minute`,
		[targetId],
	);

	return rows;

};

const readVersion = async () => {
	const { rows: [row] } = await setup.query("SELECT version FROM public.clinic_availability_versions WHERE clinic_id = $1", [clinic.clinicId]);

	return BigInt(row.version);
};

const waitForWriters = (count: number) => vi.waitFor(async () => {

	const { rows: [row] } = await setup.query(
		"SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE usename = 'medical_data_hub_api' AND wait_event_type = 'Lock'",
	);
	expect(row.count).toBe(count);

}, { interval: 10, timeout: 800 });

beforeAll(async () => {

	const { rows: [row] } = await setup.query<typeof clinic>(
		`SELECT users.clinic_id AS "clinicId", services.specialty_id AS "specialtyId", services.service_id AS "serviceId",
		        patients.patient_id AS "patientId", services.duration_minutes AS "durationMinutes"
		 FROM public.users
		 JOIN public.services USING (clinic_id) JOIN public.patients USING (clinic_id)
		 WHERE identity_id = $1 LIMIT 1`,
		[decodeJwt(administratorToken).sub],
	);
	clinic = row;
	const professionals = await setup.query<typeof own>(
		`SELECT professional_id AS "professionalId", user_id AS "userId"
		 FROM public.professionals JOIN public.users USING (clinic_id, user_id) WHERE identity_id = $1`,
		[decodeJwt(professionalToken).sub],
	);
	own = professionals.rows[0];
	const reception = await setup.query("SELECT user_id FROM public.users WHERE identity_id = $1", [decodeJwt(receptionToken).sub]);
	receptionUserId = reception.rows[0].user_id;
	const foreign = await setup.query("SELECT professional_id FROM public.professionals WHERE clinic_id <> $1 LIMIT 1", [clinic.clinicId]);
	foreignProfessionalId = foreign.rows[0].professional_id;
	await setup.query(
		`INSERT INTO public.users (user_id, identity_id, clinic_id, role) VALUES ($1, $2, $3, 'healthcare_professional')`,
		[userId, `synthetic-schedule-${userId}`, clinic.clinicId],
	);
	await setup.query(
		"INSERT INTO public.professionals (professional_id, clinic_id, user_id, specialty_id) VALUES ($1, $2, $3, $4)",
		[professionalId, clinic.clinicId, userId, clinic.specialtyId],
	);
	await setup.query(
		"INSERT INTO public.professional_services (clinic_id, professional_id, service_id) VALUES ($1, $2, $3)",
		[clinic.clinicId, professionalId, clinic.serviceId],
	);

});

afterEach(async () => {
	await setup.query("DELETE FROM public.appointments WHERE professional_id = $1", [professionalId]);
	await setup.query("DELETE FROM public.professional_schedules WHERE professional_id = $1", [professionalId]);
	await setup.query("DELETE FROM public.professional_blocks WHERE professional_id = $1", [professionalId]);
});

afterAll(async () => {

	await setup.query("DELETE FROM public.professional_services WHERE professional_id = $1", [professionalId]);
	await setup.query("DELETE FROM public.professionals WHERE professional_id = $1", [professionalId]);
	await setup.query("DELETE FROM public.users WHERE user_id = $1", [userId]);
	await setup.end();

});

it("reads the ordered stored week as each clinic role without changing availability", async () => {

	await setup.query(
		`INSERT INTO public.professional_schedules (clinic_id, professional_id, weekday, start_minute, end_minute)
		 SELECT $1::uuid, $2::uuid, weekday, start_minute, end_minute
		 FROM (VALUES (2, 780, 840), (1, 540, 600), (1, 480, 600), (1, 480, 540)) AS fixture(weekday, start_minute, end_minute)`,
		[clinic.clinicId, professionalId],
	);
	const intervals = [
		{ weekday: 1, startMinute: 480, endMinute: 540 },
		{ weekday: 1, startMinute: 480, endMinute: 600 },
		{ weekday: 1, startMinute: 540, endMinute: 600 },
		{ weekday: 2, startMinute: 780, endMinute: 840 },
	];
	const version = await readVersion();
	for(const token of [administratorToken, receptionToken, professionalToken]) {

		const response = await getWeek(professionalId.toUpperCase(), token);
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.json()).toEqual({ intervals });

	}
	expect(await readVersion()).toBe(version);

});

it("returns an empty week for an accessible professional without schedules", async () => {
	const response = await getWeek();
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ intervals: [] });
});

it("rejects invalid schedule read identifiers and extra query parameters", async () => {
	expect((await getWeek("invalid")).status).toBe(400);
	expect((await getWeek(professionalId, receptionToken, `clinicId=${clinic.clinicId}`)).status).toBe(400);
});

it("requires an authorized active local clinic user to read schedules", async () => {

	expect((await getWeek(professionalId, "")).status).toBe(401);
	expect((await getWeek(professionalId, platformToken)).status).toBe(403);
	try {
		await setup.query("UPDATE public.users SET is_active = false WHERE user_id = $1", [receptionUserId]);
		expect((await getWeek()).status).toBe(403);
	} finally {
		await setup.query("UPDATE public.users SET is_active = true WHERE user_id = $1", [receptionUserId]);
	}

});

it("returns the same not-found response for missing and foreign schedule read targets", async () => {

	for(const target of [randomUUID(), foreignProfessionalId]) {
		const response = await getWeek(target);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Not Found" });
	}

});

it("reads all past and future blocks in start and identifier order as each clinic role without changing availability", async () => {

	const [firstId, secondId, thirdId] = [randomUUID(), randomUUID(), randomUUID()].sort();
	await setup.query(
		`INSERT INTO public.professional_blocks (clinic_id, professional_id, professional_block_id, start_at, end_at)
		 VALUES ($1, $2, $3, '2030-01-07 10:00Z', '2030-01-07 10:30Z'),
		        ($1, $2, $4, '2000-01-07 10:00Z', '2000-01-07 10:30Z'),
		        ($1, $2, $5, '2030-01-07 10:00Z', '2030-01-07 11:00Z')`,
		[clinic.clinicId, professionalId, thirdId, firstId, secondId],
	);
	const blocks = [
		{ professionalBlockId: firstId, startAt: "2000-01-07T10:00:00.000Z", endAt: "2000-01-07T10:30:00.000Z" },
		{ professionalBlockId: secondId, startAt: "2030-01-07T10:00:00.000Z", endAt: "2030-01-07T11:00:00.000Z" },
		{ professionalBlockId: thirdId, startAt: "2030-01-07T10:00:00.000Z", endAt: "2030-01-07T10:30:00.000Z" },
	];
	const version = await readVersion();
	for(const token of [administratorToken, receptionToken, professionalToken]) {

		const response = await getBlocks(professionalId.toUpperCase(), token);
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.json()).toEqual({ blocks });

	}
	expect(await readVersion()).toBe(version);

});

it("returns an empty list for an accessible professional without blocks", async () => {
	const response = await getBlocks();
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ blocks: [] });
});

it("rejects invalid block read identifiers and extra query parameters", async () => {
	expect((await getBlocks("invalid")).status).toBe(400);
	expect((await getBlocks(professionalId, receptionToken, `clinicId=${clinic.clinicId}`)).status).toBe(400);
});

it("requires an authorized active local clinic user to read blocks", async () => {

	expect((await getBlocks(professionalId, "")).status).toBe(401);
	expect((await getBlocks(professionalId, platformToken)).status).toBe(403);
	try {
		await setup.query("UPDATE public.users SET is_active = false WHERE user_id = $1", [receptionUserId]);
		expect((await getBlocks()).status).toBe(403);
	} finally {
		await setup.query("UPDATE public.users SET is_active = true WHERE user_id = $1", [receptionUserId]);
	}

});

it("returns the same not-found response for missing and foreign block read targets", async () => {

	for(const target of [randomUUID(), foreignProfessionalId]) {
		const response = await getBlocks(target);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Not Found" });
	}

});

it("holds the professional lock and exposes only committed blocks until availability can commit", async () => {

	const registration = { startAt: "2030-01-07T14:00:00.000Z", endAt: "2030-01-07T15:00:00.000Z" };
	const blocker = await setup.connect();
	try {

		await blocker.query("BEGIN");
		await blocker.query("SELECT 1 FROM public.clinic_availability_versions WHERE clinic_id = $1 FOR NO KEY UPDATE", [clinic.clinicId]);
		let responded = false;
		const creation = registerBlock(registration).then((response) => {
			responded = true;

			return response;
		});
		await waitForWriters(1);
		expect(responded).toBe(false);
		const beforeCommit = await getBlocks();
		expect(beforeCommit.status).toBe(200);
		expect(await beforeCommit.json()).toEqual({ blocks: [] });
		await expect(setup.query("SELECT 1 FROM public.professionals WHERE professional_id = $1 FOR NO KEY UPDATE NOWAIT", [professionalId])).rejects.toMatchObject({ code: "55P03" });
		await blocker.query("COMMIT");
		const response = await creation;
		expect(response.status).toBe(201);
		const block = await response.json();
		const afterCommit = await getBlocks();
		expect(afterCommit.status).toBe(200);
		expect(await afterCommit.json()).toEqual({ blocks: [{ professionalBlockId: block.professionalBlockId, ...registration }] });

	} finally {
		await blocker.query("ROLLBACK");
		blocker.release();
	}

});

it("creates a finite past block with explicit offsets and one committed availability increment", async () => {

	const version = await readVersion();
	const response = await registerBlock(blockRegistration);
	expect(response.status).toBe(201);
	const block = await response.json();
	expect(block).toEqual({ professionalBlockId: expect.any(String) });
	const { rows } = await setup.query(
		`SELECT block.clinic_id AS "clinicId", block.professional_id AS "professionalId", block.start_at AS "startAt", block.end_at AS "endAt",
		        block.xmin::text AS "blockTransaction", version.xmin::text AS "versionTransaction"
		 FROM public.professional_blocks AS block JOIN public.clinic_availability_versions AS version USING (clinic_id)
		 WHERE professional_block_id = $1`,
		[block.professionalBlockId],
	);
	expect(rows).toEqual([{
		clinicId: clinic.clinicId, professionalId,
		startAt: new Date("2000-01-07T14:00:00.123Z"), endAt: new Date("2000-01-07T14:00:00.124Z"),
		blockTransaction: expect.any(String), versionTransaction: rows[0].blockTransaction,
	}]);
	expect(await readVersion()).toBe(version+1n);

});

it("creates blocks only for the protected own profile and ignores other professionals' reservations", async () => {

	await createFullWeek();
	await setup.query(
		`INSERT INTO public.appointments (clinic_id, professional_id, patient_id, service_id, start_at, end_at)
		 VALUES ($1, $2, $3, $4, '2000-01-07 14:00Z', '2000-01-07 14:00Z'::timestamptz+$5::int*interval '1 minute')`,
		[clinic.clinicId, professionalId, clinic.patientId, clinic.serviceId, clinic.durationMinutes],
	);
	let createdBlockId: string | undefined;
	try {

		const response = await registerBlock(blockRegistration, professionalToken, own.professionalId.toUpperCase());
		expect(response.status).toBe(201);
		createdBlockId = (await response.json()).professionalBlockId;
		for(const target of [professionalId, foreignProfessionalId, randomUUID()]) {
			expect((await registerBlock(blockRegistration, professionalToken, target)).status).toBe(403);
		}
		expect(await readBlocks()).toEqual([]);

	} finally {
		await setup.query("DELETE FROM public.professional_blocks WHERE professional_block_id = $1", [createdBlockId]);
	}

});

it("requires a valid block writer token and current local authorization", async () => {

	expect((await registerBlock(blockRegistration, "")).status).toBe(401);
	for(const token of [receptionToken, platformToken]) {
		expect((await registerBlock(blockRegistration, token)).status).toBe(403);
	}
	try {
		await setup.query("UPDATE public.users SET is_active = false WHERE user_id = $1", [own.userId]);
		expect((await registerBlock(blockRegistration, professionalToken, own.professionalId)).status).toBe(403);
	} finally {
		await setup.query("UPDATE public.users SET is_active = true WHERE user_id = $1", [own.userId]);
	}

});

it("rejects invalid block registration fields and nonpositive durations without changes", async () => {

	const version = await readVersion();
	const invalidBodies = [
		{}, { startAt: blockRegistration.startAt }, { endAt: blockRegistration.endAt },
		{ ...blockRegistration, startAt: "2000-01-07T08:00" }, { ...blockRegistration, endAt: null },
		{ ...blockRegistration, endAt: blockRegistration.startAt }, { ...blockRegistration, endAt: "1999-01-01T00:00Z" },
		{ ...blockRegistration, clinicId: clinic.clinicId },
	];
	for(const body of invalidBodies) {
		expect((await registerBlock(body)).status, JSON.stringify(body)).toBe(400);
	}
	expect((await registerBlock(blockRegistration, administratorToken, "invalid")).status).toBe(400);
	expect(await readBlocks()).toEqual([]);
	expect(await readVersion()).toBe(version);

});

it("hides missing and foreign professionals during block registration", async () => {
	for(const target of [randomUUID(), foreignProfessionalId]) {
		expect((await registerBlock(blockRegistration, administratorToken, target)).status).toBe(404);
	}
});

it("reports reserved block conflicts across dates including past appointments without creating a block", async () => {

	await createFullWeek();
	const { rows: appointments } = await setup.query(
		`INSERT INTO public.appointments (clinic_id, professional_id, patient_id, service_id, start_at, end_at, state)
		 SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, start_at, start_at+$5::int*interval '1 minute', state::public.appointment_state
		 FROM (VALUES ('2000-01-08 03:00Z'::timestamptz, 'reserved'), ('2000-01-07 23:59Z', 'reserved'),
		              ('2000-01-08 01:00Z', 'attended')) AS fixture(start_at, state)
		 RETURNING appointment_id AS "appointmentId", patient_id AS "patientId", service_id AS "serviceId", start_at AS "startAt", end_at AS "endAt", state`,
		[clinic.clinicId, professionalId, clinic.patientId, clinic.serviceId, clinic.durationMinutes],
	);
	const version = await readVersion();
	const response = await registerBlock({ startAt: "2000-01-08T00:00Z", endAt: "2000-01-08T04:30Z" });
	expect(response.status).toBe(409);
	const conflicts = appointments.filter((row) => row.state === "reserved")
		.sort((left, right) => left.startAt.getTime()-right.startAt.getTime())
		.map(({ appointmentId, patientId, serviceId, startAt, endAt }) => ({ appointmentId, patientId, serviceId, startAt: startAt.toISOString(), endAt: endAt.toISOString() }));
	expect(await response.json()).toEqual({ error: "Conflict", conflicts });
	expect(await readBlocks()).toEqual([]);
	expect(await readVersion()).toBe(version);
	const persisted = await setup.query("SELECT state FROM public.appointments WHERE professional_id = $1 ORDER BY start_at", [professionalId]);
	expect(persisted.rows).toEqual([{ state: "reserved" }, { state: "attended" }, { state: "reserved" }]);

});

it("allows adjacent reservations and overlapping blocks while ignoring final appointments", async () => {

	await createFullWeek();
	await setup.query(
		`INSERT INTO public.appointments (clinic_id, professional_id, patient_id, service_id, start_at, end_at, state)
		 SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, start_at, start_at+$5::int*interval '1 minute', state::public.appointment_state
		 FROM (VALUES ('2000-01-07 14:00Z'::timestamptz-$5::int*interval '1 minute', 'reserved'),
		              ('2000-01-07 15:00Z', 'reserved'), ('2000-01-07 14:10Z', 'attended')) AS fixture(start_at, state)`,
		[clinic.clinicId, professionalId, clinic.patientId, clinic.serviceId, clinic.durationMinutes],
	);
	await setup.query(
		`INSERT INTO public.professional_blocks (clinic_id, professional_id, start_at, end_at)
		 VALUES ($1, $2, '2000-01-07 14:00Z', '2000-01-07 14:30Z')`,
		[clinic.clinicId, professionalId],
	);
	const version = await readVersion();
	expect((await registerBlock({ startAt: "2000-01-07T14:00Z", endAt: "2000-01-07T15:00Z" })).status).toBe(201);
	expect(await readBlocks()).toHaveLength(2);
	expect(await readVersion()).toBe(version+1n);

});

it.each([
	{ resource: "weekly schedule", operation: "booking" }, { resource: "block", operation: "booking" },
	{ resource: "weekly schedule", operation: "rescheduling" }, { resource: "block", operation: "rescheduling" },
])("rechecks $resource conflicts after an API $operation commits", async ({ resource, operation }) => {

	await createFullWeek();
	const gate = new Client({ connectionString: setupUrl });
	await gate.connect();
	let appointmentId: string | undefined;
	if(operation === "rescheduling") {

		const response = await fetch(new URL("/appointments", apiUrl), {
			method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${receptionToken}` },
			body: JSON.stringify({ patientId: clinic.patientId, professionalId, serviceId: clinic.serviceId, startAt: new Date(Date.parse("2035-01-08T14:00Z")-clinic.durationMinutes*60_000).toISOString() }),
		});
		expect(response.status).toBe(201);
		appointmentId = (await response.json()).appointmentId;

	}
	const version = await readVersion();
	try {

		await gate.query("BEGIN");
		await gate.query("SELECT 1 FROM public.clinic_availability_versions WHERE clinic_id = $1 FOR NO KEY UPDATE", [clinic.clinicId]);
		const path = appointmentId ? `/appointments/${appointmentId}/reschedule` : "/appointments";
		const body = { professionalId, startAt: "2035-01-08T14:00Z", ...(appointmentId ? {} : { patientId: clinic.patientId, serviceId: clinic.serviceId }) };
		const reservation = fetch(new URL(path, apiUrl), {
			method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${receptionToken}` },
			body: JSON.stringify(body),
		});
		await waitForWriters(1);
		const change = resource === "block"
			? registerBlock({ startAt: "2035-01-08T14:00Z", endAt: "2035-01-08T15:00Z" })
			: replaceWeek({ intervals: [] });
		await waitForWriters(2);
		await gate.query("COMMIT");
		expect((await reservation).status).toBe(201);
		expect((await change).status).toBe(409);
		expect(await readWeek()).toHaveLength(7);
		expect(await readBlocks()).toEqual([]);
		expect(await readVersion()).toBe(version+1n);

	} finally {
		await gate.query("ROLLBACK");
		await gate.end();
	}

});

it.each(["missing", "overflowed"])("rolls back block creation when the availability version is %s", async (failure) => {

	const version = await readVersion();
	try {

		const query = failure === "missing"
			? "DELETE FROM public.clinic_availability_versions WHERE clinic_id = $1"
			: "UPDATE public.clinic_availability_versions SET version = 9223372036854775807 WHERE clinic_id = $1";
		await setup.query(query, [clinic.clinicId]);
		expect((await registerBlock(blockRegistration)).status).toBe(500);
		expect(await readBlocks()).toEqual([]);

	} finally {

		await setup.query(
			`INSERT INTO public.clinic_availability_versions (clinic_id, version) VALUES ($1, $2)
			 ON CONFLICT (clinic_id) DO UPDATE SET version = EXCLUDED.version`,
			[clinic.clinicId, version.toString()],
		);

	}

});

it("replaces the complete week with submitted intervals and one committed availability increment", async () => {

	const intervals = [
		{ weekday: 1, startMinute: 480, endMinute: 600 },
		{ weekday: 1, startMinute: 540, endMinute: 720 },
		{ weekday: 7, startMinute: 1380, endMinute: 1440 },
	];
	await setup.query(
		"INSERT INTO public.professional_schedules (clinic_id, professional_id, weekday, start_minute, end_minute) VALUES ($1, $2, 2, 0, 60)",
		[clinic.clinicId, professionalId],
	);
	const version = await readVersion();
	const response = await replaceWeek({ intervals });
	expect(response.status).toBe(204);
	expect(await response.text()).toBe("");
	expect(await readWeek()).toEqual(intervals);
	expect(await readVersion()).toBe(version+1n);
	const { rows } = await setup.query(
		`SELECT DISTINCT schedule.xmin::text AS "scheduleTransaction", version.xmin::text AS "versionTransaction"
		 FROM public.professional_schedules AS schedule JOIN public.clinic_availability_versions AS version USING (clinic_id)
		 WHERE professional_id = $1`,
		[professionalId],
	);
	expect(rows).toEqual([{ scheduleTransaction: expect.any(String), versionTransaction: rows[0].scheduleTransaction }]);

});

it("clears a week without reservations", async () => {
	expect((await replaceWeek({ intervals: [{ weekday: 1, startMinute: 0, endMinute: 1440 }] })).status).toBe(204);
	expect((await replaceWeek({ intervals: [] })).status).toBe(204);
	expect(await readWeek()).toEqual([]);
});

it("allows a professional to replace only the protected own profile's week", async () => {

	const original = await readWeek(own.professionalId);
	const intervals = Array.from({ length: 7 }, (_, index) => ({ weekday: index+1, startMinute: 0, endMinute: 1440 }));
	try {

		expect((await replaceWeek({ intervals }, professionalToken, own.professionalId.toUpperCase())).status).toBe(204);
		expect(await readWeek(own.professionalId)).toEqual(intervals);
		for(const target of [professionalId, foreignProfessionalId, randomUUID()]) {
			expect((await replaceWeek({ intervals: [] }, professionalToken, target)).status).toBe(403);
		}

	} finally {

		await setup.query("DELETE FROM public.professional_schedules WHERE professional_id = $1", [own.professionalId]);
		for(const interval of original) {

			await setup.query(
				"INSERT INTO public.professional_schedules (clinic_id, professional_id, weekday, start_minute, end_minute) VALUES ($1, $2, $3, $4, $5)",
				[clinic.clinicId, own.professionalId, interval.weekday, interval.startMinute, interval.endMinute],
			);

		}

	}

});

it("requires a valid schedule writer token and current local authorization", async () => {

	expect((await replaceWeek({ intervals: [] }, "")).status).toBe(401);
	for(const token of [receptionToken, platformToken]) {
		expect((await replaceWeek({ intervals: [] }, token)).status).toBe(403);
	}
	try {

		await setup.query("UPDATE public.users SET is_active = false WHERE user_id = $1", [own.userId]);
		expect((await replaceWeek({ intervals: [] }, professionalToken, own.professionalId)).status).toBe(403);
		await setup.query("UPDATE public.users SET is_active = true, role = 'reception' WHERE user_id = $1", [own.userId]);
		expect((await replaceWeek({ intervals: [] }, professionalToken, own.professionalId)).status).toBe(403);
		await setup.query("UPDATE public.users SET role = 'healthcare_professional' WHERE user_id = $1", [own.userId]);
		await setup.query("UPDATE public.professionals SET user_id = $2 WHERE professional_id = $1", [own.professionalId, receptionUserId]);
		expect((await replaceWeek({ intervals: [] }, professionalToken, own.professionalId)).status).toBe(403);

	} finally {
		await setup.query("UPDATE public.users SET is_active = true, role = 'healthcare_professional' WHERE user_id = $1", [own.userId]);
		await setup.query("UPDATE public.professionals SET user_id = $2 WHERE professional_id = $1", [own.professionalId, own.userId]);
	}

});

it("rejects invalid weekly intervals and ownership overrides without changes", async () => {

	const interval = { weekday: 1, startMinute: 0, endMinute: 1440 };
	const invalidBodies = [
		null, [], {}, { intervals: null }, { intervals: {} }, { intervals: [null] }, { intervals: [[]] },
		{ intervals: [], clinicId: clinic.clinicId },
		...[{ weekday: 0 }, { weekday: 8 }, { weekday: 1.5 }, { weekday: "1" }, { startMinute: -1 },
			{ startMinute: 0.5 }, { endMinute: 0 }, { endMinute: 1441 }, { endMinute: "60" },
			{ professionalId }].map((fields) => ({ intervals: [{ ...interval, ...fields }] })),
	];
	const version = await readVersion();
	for(const body of invalidBodies) {
		expect((await replaceWeek(body)).status, JSON.stringify(body)).toBe(400);
	}
	expect((await replaceWeek({ intervals: [] }, administratorToken, "invalid")).status).toBe(400);
	expect(await readWeek()).toEqual([]);
	expect(await readVersion()).toBe(version);

});

it("hides absent and foreign professionals from administrator schedule replacement", async () => {
	for(const target of [foreignProfessionalId, randomUUID()]) {
		expect((await replaceWeek({ intervals: [] }, administratorToken, target)).status).toBe(404);
	}
});

it("reports every uncovered reservation including past and cross-date appointments without changing the week", async () => {

	const intervals = Array.from({ length: 7 }, (_, index) => ({ weekday: index+1, startMinute: 0, endMinute: 1440 }));
	expect((await replaceWeek({ intervals })).status).toBe(204);
	const { rows: reservations } = await setup.query(
		`INSERT INTO public.appointments (clinic_id, professional_id, patient_id, service_id, start_at, end_at, state)
		 SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, start_at, start_at+interval '30 minutes', state::public.appointment_state
		 FROM (VALUES ('2030-01-08 05:45Z'::timestamptz, 'reserved'), ('2000-01-03 14:00Z', 'reserved'),
		              ('2030-01-09 14:00Z', 'attended')) AS fixture(start_at, state)
		 RETURNING appointment_id AS "appointmentId", patient_id AS "patientId", service_id AS "serviceId", start_at AS "startAt", end_at AS "endAt", state`,
		[clinic.clinicId, professionalId, clinic.patientId, clinic.serviceId],
	);
	const version = await readVersion();
	const response = await replaceWeek({ intervals: [{ weekday: 1, startMinute: 1380, endMinute: 1440 }] });
	expect(response.status).toBe(409);
	const conflicts = reservations.filter((row) => row.state === "reserved")
		.sort((left, right) => left.startAt.getTime()-right.startAt.getTime())
		.map(({ appointmentId, patientId, serviceId, startAt, endAt }) => ({ appointmentId, patientId, serviceId, startAt: startAt.toISOString(), endAt: endAt.toISOString() }));
	expect(await response.json()).toEqual({ error: "Conflict", conflicts });
	expect(await readWeek()).toEqual(intervals);
	expect(await readVersion()).toBe(version);
	const persisted = await setup.query("SELECT state FROM public.appointments WHERE professional_id = $1 ORDER BY start_at", [professionalId]);
	expect(persisted.rows).toEqual([{ state: "reserved" }, { state: "reserved" }, { state: "attended" }]);

});

it("keeps reservations covered through adjacent intervals and across midnight", async () => {

	await setup.query(
		`INSERT INTO public.appointments (clinic_id, professional_id, patient_id, service_id, start_at, end_at)
		 VALUES ($1, $2, $3, $4, '2030-01-08 05:45Z', '2030-01-08 06:15Z')`,
		[clinic.clinicId, professionalId, clinic.patientId, clinic.serviceId],
	);
	const intervals = [
		{ weekday: 1, startMinute: 1425, endMinute: 1430 },
		{ weekday: 1, startMinute: 1430, endMinute: 1440 },
		{ weekday: 2, startMinute: 0, endMinute: 15 },
	];
	expect((await replaceWeek({ intervals })).status).toBe(204);
	expect(await readWeek()).toEqual(intervals);

});

it("lets the later successful complete-week replacement win after a lock wait", async () => {

	const blocker = await setup.connect();
	const firstWeek = [{ weekday: 1, startMinute: 480, endMinute: 600 }];
	const secondWeek = [{ weekday: 2, startMinute: 600, endMinute: 720 }];
	const version = await readVersion();
	try {

		await blocker.query("BEGIN");
		await blocker.query("SELECT 1 FROM public.professionals WHERE professional_id = $1 FOR NO KEY UPDATE", [professionalId]);
		const first = replaceWeek({ intervals: firstWeek });
		await waitForWriters(1);
		const second = replaceWeek({ intervals: secondWeek });
		await waitForWriters(2);
		await blocker.query("COMMIT");
		expect((await first).status).toBe(204);
		expect((await second).status).toBe(204);
		expect(await readWeek()).toEqual(secondWeek);
		expect(await readVersion()).toBe(version+2n);

	} finally {
		await blocker.query("ROLLBACK");
		blocker.release();
	}

});

it("holds the professional lock and withholds success until the availability write can commit", async () => {

	const currentWeek = [{ weekday: 3, startMinute: 480, endMinute: 600 }];
	const nextWeek = [{ weekday: 1, startMinute: 0, endMinute: 1440 }];
	await setup.query(
		"INSERT INTO public.professional_schedules (clinic_id, professional_id, weekday, start_minute, end_minute) VALUES ($1, $2, 3, 480, 600)",
		[clinic.clinicId, professionalId],
	);
	const blocker = await setup.connect();
	try {

		await blocker.query("BEGIN");
		await blocker.query("SELECT 1 FROM public.clinic_availability_versions WHERE clinic_id = $1 FOR NO KEY UPDATE", [clinic.clinicId]);
		let responded = false;
		const replacement = replaceWeek({ intervals: nextWeek }).then((response) => {
			responded = true;

			return response;
		});
		await waitForWriters(1);
		expect(responded).toBe(false);
		const beforeCommit = await getWeek();
		expect(beforeCommit.status).toBe(200);
		expect(await beforeCommit.json()).toEqual({ intervals: currentWeek });
		await expect(setup.query("SELECT 1 FROM public.professionals WHERE professional_id = $1 FOR NO KEY UPDATE NOWAIT", [professionalId])).rejects.toMatchObject({ code: "55P03" });
		await blocker.query("COMMIT");
		expect((await replacement).status).toBe(204);
		const afterCommit = await getWeek();
		expect(afterCommit.status).toBe(200);
		expect(await afterCommit.json()).toEqual({ intervals: nextWeek });

	} finally {
		await blocker.query("ROLLBACK");
		blocker.release();
	}

});

it("rolls back the entire replacement when the availability version is missing", async () => {

	const intervals = [{ weekday: 1, startMinute: 480, endMinute: 540 }];
	expect((await replaceWeek({ intervals })).status).toBe(204);
	const version = await readVersion();
	try {
		await setup.query("DELETE FROM public.clinic_availability_versions WHERE clinic_id = $1", [clinic.clinicId]);
		expect((await replaceWeek({ intervals: [] })).status).toBe(500);
		expect(await readWeek()).toEqual(intervals);
	} finally {
		await setup.query("INSERT INTO public.clinic_availability_versions (clinic_id, version) VALUES ($1, $2)", [clinic.clinicId, version.toString()]);
	}

});
