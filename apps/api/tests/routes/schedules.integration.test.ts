import { randomUUID } from "node:crypto";
import { decodeJwt } from "jose";
import { Client, Pool } from "pg";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const apiUrl = process.env.SCHEDULE_TEST_API_URL;
const setupUrl = process.env.SCHEDULE_TEST_DATABASE_SETUP_URL;
const runtimeUrl = process.env.DATABASE_URL;
const administratorToken = process.env.SCHEDULE_TEST_ADMIN_TOKEN;
const professionalToken = process.env.SCHEDULE_TEST_PROFESSIONAL_TOKEN;
const receptionToken = process.env.SCHEDULE_TEST_RECEPTION_TOKEN;
const platformToken = process.env.SCHEDULE_TEST_PLATFORM_TOKEN;
if(!apiUrl || !setupUrl || !runtimeUrl || !administratorToken || !professionalToken || !receptionToken || !platformToken) {
	throw new Error("Configure the schedule test API, disposable database, and Keycloak tokens");
}

const setup = new Pool({ connectionString: setupUrl });
const professionalId = randomUUID();
const userId = randomUUID();
let clinic: { clinicId: string; specialtyId: string; serviceId: string; patientId: string };
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
		        patients.patient_id AS "patientId"
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
});

afterAll(async () => {

	await setup.query("DELETE FROM public.professional_services WHERE professional_id = $1", [professionalId]);
	await setup.query("DELETE FROM public.professionals WHERE professional_id = $1", [professionalId]);
	await setup.query("DELETE FROM public.users WHERE user_id = $1", [userId]);
	await setup.end();

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

it("rechecks reservations committed by a competing transaction after the professional lock wait", async () => {

	const writer = new Client({ connectionString: runtimeUrl });
	await writer.connect();
	const intervals = [{ weekday: 1, startMinute: 480, endMinute: 540 }];
	expect((await replaceWeek({ intervals })).status).toBe(204);
	try {

		await writer.query("BEGIN ISOLATION LEVEL READ COMMITTED");
		await writer.query("SELECT * FROM public.lock_user_for_share($1::uuid, $1::uuid)", [receptionUserId]);
		await writer.query("SELECT set_config('app.user_id', $1, true), set_config('app.clinic_id', $2, true)", [receptionUserId, clinic.clinicId]);
		await writer.query("SET LOCAL ROLE reception");
		await writer.query("SELECT * FROM public.lock_service_for_share($1::uuid)", [clinic.serviceId]);
		await writer.query("SELECT * FROM public.lock_professional_for_no_key_update($1::uuid)", [professionalId]);
		await writer.query("SELECT 1 FROM public.patients WHERE patient_id = $1 FOR NO KEY UPDATE", [clinic.patientId]);
		await writer.query(
			`INSERT INTO public.appointments (clinic_id, professional_id, patient_id, service_id, start_at, end_at)
			 VALUES ($1, $2, $3, $4, '2030-01-07 14:00Z', '2030-01-07 14:30Z')`,
			[clinic.clinicId, professionalId, clinic.patientId, clinic.serviceId],
		);
		const replacement = replaceWeek({ intervals: [] });
		await waitForWriters(1);
		await writer.query("UPDATE public.clinic_availability_versions SET version = version+1 WHERE clinic_id = $1", [clinic.clinicId]);
		await writer.query("COMMIT");
		expect((await replacement).status).toBe(409);
		expect(await readWeek()).toEqual(intervals);

	} finally {
		await writer.query("ROLLBACK");
		await writer.end();
	}

});

it("holds the professional lock and withholds success until the availability write can commit", async () => {

	const blocker = await setup.connect();
	try {

		await blocker.query("BEGIN");
		await blocker.query("SELECT 1 FROM public.clinic_availability_versions WHERE clinic_id = $1 FOR NO KEY UPDATE", [clinic.clinicId]);
		let responded = false;
		const replacement = replaceWeek({ intervals: [{ weekday: 1, startMinute: 0, endMinute: 1440 }] }).then((response) => {
			responded = true;

			return response;
		});
		await waitForWriters(1);
		expect(responded).toBe(false);
		expect(await readWeek()).toEqual([]);
		await expect(setup.query("SELECT 1 FROM public.professionals WHERE professional_id = $1 FOR NO KEY UPDATE NOWAIT", [professionalId])).rejects.toMatchObject({ code: "55P03" });
		await blocker.query("COMMIT");
		expect((await replacement).status).toBe(204);

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
