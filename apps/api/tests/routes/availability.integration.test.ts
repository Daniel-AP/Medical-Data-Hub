import { randomUUID } from "node:crypto";
import { decodeJwt } from "jose";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const apiUrl = process.env.AVAILABILITY_TEST_API_URL;
const setupUrl = process.env.AVAILABILITY_TEST_DATABASE_SETUP_URL;
const administratorToken = process.env.AVAILABILITY_TEST_ADMIN_TOKEN;
const receptionToken = process.env.AVAILABILITY_TEST_RECEPTION_TOKEN;
const professionalToken = process.env.AVAILABILITY_TEST_PROFESSIONAL_TOKEN;
const platformToken = process.env.AVAILABILITY_TEST_PLATFORM_TOKEN;
if(!apiUrl || !setupUrl || !administratorToken || !receptionToken || !professionalToken || !platformToken) {
	throw new Error("Configure the availability test API, disposable database setup URL, and Keycloak tokens");
}

const setup = new Pool({ connectionString: setupUrl });
const [firstProfessionalId, secondProfessionalId] = [randomUUID(), randomUUID()].sort();
const specialtyId = randomUUID();
const otherSpecialtyId = randomUUID();
const serviceId = randomUUID();
const otherServiceId = randomUUID();
const inactiveServiceId = randomUUID();
const emptyServiceId = randomUUID();
const patientId = randomUUID();
const ineligible = [
	{ professionalId: randomUUID(), role: "healthcare_professional", active: false, specialtyId, associationActive: true },
	{ professionalId: randomUUID(), role: "reception", active: true, specialtyId, associationActive: true },
	{ professionalId: randomUUID(), role: "healthcare_professional", active: true, specialtyId: otherSpecialtyId, associationActive: true },
	{ professionalId: randomUUID(), role: "healthcare_professional", active: true, specialtyId, associationActive: false },
];
const professionals = [
	{ professionalId: secondProfessionalId, role: "healthcare_professional", active: true, specialtyId, associationActive: true },
	{ professionalId: firstProfessionalId, role: "healthcare_professional", active: true, specialtyId, associationActive: true },
	...ineligible,
].map((professional) => ({ ...professional, userId: randomUUID() }));
const professionalIds = professionals.map((professional) => professional.professionalId);
const serviceIds = [serviceId, otherServiceId, inactiveServiceId, emptyServiceId];
let actor: { clinicId: string; userId: string; timeZone: string };
let foreign: { clinicId: string; professionalId: string; serviceId: string };

const today = new Date();
const daysUntilMonday = (8-today.getUTCDay())%7+7;
const dateAt = (offset: number) => {
	const day = today.getUTCDate()+daysUntilMonday+offset;

	return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), day)).toISOString().slice(0, 10);
};
const monday = dateAt(0);
const tuesday = dateAt(1);
const wednesday = dateAt(2);
const firstStarts = ["06:00", "06:01", "14:00", "14:01", "14:02"].map((time) => monday+"T"+time+":00.000Z");
const secondMondayStarts = [monday+"T15:00:00.000Z"];
const secondTuesdayStarts = [tuesday+"T14:00:00.000Z", wednesday+"T05:58:00.000Z", wednesday+"T05:59:00.000Z"];

const professionalPath = (id: string) => "/professionals/"+id+"/availability";
const servicePath = (id: string) => "/services/"+id+"/availability";
const professionalQuery = "serviceId="+serviceId+"&date="+monday;
const serviceQuery = "from="+monday+"&to="+wednesday;

const getAvailability = (path: string, query: string, token?: string) => {
	const url = new URL(path, apiUrl);
	url.search = query;

	return fetch(url, { headers: token ? { Authorization: "Bearer "+token } : undefined });
};

const post = (path: string, token: string, body: unknown) => {

	return fetch(new URL(path, apiUrl), {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: "Bearer "+token },
		body: JSON.stringify(body),
	});

};

const expectedRange = (firstMonday: string[], secondTuesday: string[]) => ({
	serviceId,
	dates: [
		{ date: monday, professionals: [
			{ professionalId: firstProfessionalId, starts: firstMonday },
			{ professionalId: secondProfessionalId, starts: secondMondayStarts },
		] },
		{ date: tuesday, professionals: [{ professionalId: secondProfessionalId, starts: secondTuesday }] },
		{ date: wednesday, professionals: [] },
	],
});

beforeAll(async () => {

	const { rows } = await setup.query<typeof actor>(
		`SELECT account.clinic_id AS "clinicId", account.user_id AS "userId", clinic.time_zone AS "timeZone"
		 FROM public.users AS account JOIN public.clinics AS clinic USING (clinic_id) WHERE identity_id = $1`,
		[decodeJwt(receptionToken).sub],
	);
	[actor] = rows;
	expect(actor.timeZone).toBe("America/Costa_Rica");
	({ rows: [foreign] } = await setup.query<typeof foreign>(
		`SELECT clinic_id AS "clinicId", service_id AS "serviceId", professional_id AS "professionalId"
		 FROM public.services JOIN public.professionals USING (clinic_id) WHERE clinic_id <> $1 LIMIT 1`,
		[actor.clinicId],
	));

	for(const id of [specialtyId, otherSpecialtyId]) {
		await setup.query("INSERT INTO public.specialties (specialty_id, clinic_id, name) VALUES ($1, $2, $3)", [id, actor.clinicId, id]);
	}
	for(const id of serviceIds) {

		await setup.query(
			`INSERT INTO public.services (service_id, clinic_id, name, duration_minutes, specialty_id, is_active)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			[id, actor.clinicId, id, id === otherServiceId ? 1 : 2, specialtyId, id !== inactiveServiceId],
		);

	}
	for(const professional of professionals) {

		const { professionalId, userId, role, active, specialtyId: professionalSpecialtyId, associationActive } = professional;
		await setup.query(
			"INSERT INTO public.users (user_id, identity_id, clinic_id, role, is_active) VALUES ($1, $2, $3, $4, $5)",
			[userId, "synthetic-availability-"+userId, actor.clinicId, role, active],
		);
		await setup.query(
			"INSERT INTO public.professionals (professional_id, clinic_id, user_id, specialty_id) VALUES ($1, $2, $3, $4)",
			[professionalId, actor.clinicId, userId, professionalSpecialtyId],
		);
		await setup.query(
			"INSERT INTO public.professional_services (clinic_id, professional_id, service_id, is_active) VALUES ($1, $2, $3, $4)",
			[actor.clinicId, professionalId, serviceId, associationActive],
		);

	}
	await setup.query(
		"INSERT INTO public.professional_services (clinic_id, professional_id, service_id) VALUES ($1, $2, $3), ($1, $2, $4)",
		[actor.clinicId, firstProfessionalId, otherServiceId, inactiveServiceId],
	);
	await setup.query(
		`INSERT INTO public.professional_schedules (clinic_id, professional_id, weekday, start_minute, end_minute)
		 VALUES ($1, $2, 1, 0, 3), ($1, $2, 1, 480, 484), ($1, $3, 1, 540, 542),
		        ($1, $3, 2, 480, 482), ($1, $3, 2, 1438, 1440), ($1, $3, 3, 0, 1)`,
		[actor.clinicId, firstProfessionalId, secondProfessionalId],
	);
	await setup.query(
		`INSERT INTO public.professional_schedules (clinic_id, professional_id, weekday, start_minute, end_minute)
		 SELECT $1, professional_id, 1, 480, 482 FROM unnest($2::uuid[]) AS professional_id`,
		[actor.clinicId, ineligible.map((professional) => professional.professionalId)],
	);
	await setup.query(
		`INSERT INTO public.patients (patient_id, clinic_id, identification, name, date_of_birth, email)
		 VALUES ($1, $2, $3, 'Synthetic Availability Patient', DATE '1990-01-01', 'availability@example.test')`,
		[patientId, actor.clinicId, patientId],
	);

});

afterEach(async () => {
	await setup.query("DELETE FROM public.appointments WHERE patient_id = $1", [patientId]);
	await setup.query("DELETE FROM public.professional_blocks WHERE professional_id = ANY($1::uuid[])", [professionalIds]);
});

afterAll(async () => {

	try {

		await setup.query("DELETE FROM public.professional_schedules WHERE professional_id = ANY($1::uuid[])", [professionalIds]);
		await setup.query("DELETE FROM public.professional_services WHERE professional_id = ANY($1::uuid[])", [professionalIds]);
		await setup.query("DELETE FROM public.professionals WHERE professional_id = ANY($1::uuid[])", [professionalIds]);
		await setup.query("DELETE FROM public.users WHERE user_id = ANY($1::uuid[])", [professionals.map(({ userId }) => userId)]);
		await setup.query("DELETE FROM public.services WHERE service_id = ANY($1::uuid[])", [serviceIds]);
		await setup.query("DELETE FROM public.specialties WHERE specialty_id = ANY($1::uuid[])", [[specialtyId, otherSpecialtyId]]);
		await setup.query("DELETE FROM public.patients WHERE patient_id = $1", [patientId]);

	} finally {
		await setup.end();
	}

});

it("enforces authentication and clinic roles on both availability routes without advancing the version", async () => {

	const readVersion = () => setup.query("SELECT version FROM public.clinic_availability_versions WHERE clinic_id = $1", [actor.clinicId]);
	const { rows: before } = await readVersion();
	for(const [path, query] of [[professionalPath(firstProfessionalId), professionalQuery], [servicePath(serviceId), serviceQuery]]) {

		expect((await getAvailability(path, query)).status).toBe(401);
		expect((await getAvailability(path, query, "invalid-token")).status).toBe(401);
		expect((await getAvailability(path, query, platformToken)).status).toBe(403);
		for(const token of [administratorToken, receptionToken, professionalToken]) {
			const response = await getAvailability(path, query, token);
			expect(response.status).toBe(200);
			expect(response.headers.get("Cache-Control")).toBe("no-store");
		}

	}
	expect((await readVersion()).rows).toEqual(before);

});

it("hides missing and foreign availability resources and rejects clinic overrides", async () => {

	const missing = randomUUID();
	const requests = [
		[professionalPath(missing), professionalQuery],
		[professionalPath(foreign.professionalId), professionalQuery],
		[professionalPath(firstProfessionalId), "serviceId="+foreign.serviceId+"&date="+monday],
		[servicePath(missing), serviceQuery],
		[servicePath(foreign.serviceId), serviceQuery],
	];
	for(const [path, query] of requests) {
		const response = await getAvailability(path, query, receptionToken);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Not Found" });
	}
	expect((await getAvailability(servicePath(serviceId), serviceQuery+"&clinicId="+foreign.clinicId, receptionToken)).status).toBe(400);
	expect((await getAvailability(professionalPath(firstProfessionalId), professionalQuery+"&clinicId="+foreign.clinicId, receptionToken)).status).toBe(400);

});

it("returns ordered eligible availability and accepts inactive services", async () => {

	const response = await getAvailability(servicePath(serviceId), serviceQuery, receptionToken);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual(expectedRange(firstStarts, secondTuesdayStarts));
	for(const professional of ineligible) {
		expect((await getAvailability(professionalPath(professional.professionalId), professionalQuery, receptionToken)).status).toBe(409);
	}
	const inactive = await getAvailability(professionalPath(firstProfessionalId), "serviceId="+inactiveServiceId+"&date="+monday, receptionToken);
	expect(inactive.status).toBe(200);
	expect(await inactive.json()).toEqual({ professionalId: firstProfessionalId, serviceId: inactiveServiceId, date: monday, starts: firstStarts });
	const inactiveRange = await getAvailability(servicePath(inactiveServiceId), serviceQuery, receptionToken);
	expect(inactiveRange.status).toBe(200);
	expect(await inactiveRange.json()).toEqual({
		serviceId: inactiveServiceId,
		dates: [
			{ date: monday, professionals: [{ professionalId: firstProfessionalId, starts: firstStarts }] },
			{ date: tuesday, professionals: [] },
			{ date: wednesday, professionals: [] },
		],
	});

});

it("validates availability inputs and returns every date of an empty 31-day range", async () => {

	const target = professionalPath(firstProfessionalId);
	const emptyRange = servicePath(emptyServiceId);
	const invalid = [
		[professionalPath("invalid"), professionalQuery],
		[target, "serviceId=invalid&date="+monday],
		[target, "date="+monday],
		[target, "serviceId="+serviceId+"&date=2000-02-30"],
		[target, "serviceId="+serviceId+"&date=2000-01-01"],
		[target, professionalQuery+"&date="+tuesday],
		[emptyRange, "from="+monday],
		[emptyRange, "from="+monday+"&to="+dateAt(31)],
		[emptyRange, "from="+tuesday+"&to="+monday],
		[emptyRange, "from=2000-01-01&to=2000-01-02"],
	];
	for(const [path, query] of invalid) {
		expect((await getAvailability(path, query, receptionToken)).status).toBe(400);
	}
	const range = await getAvailability(emptyRange, "from="+monday+"&to="+dateAt(30), receptionToken);
	expect(range.status).toBe(200);
	expect(await range.json()).toEqual({
		serviceId: emptyServiceId,
		dates: Array.from({ length: 31 }, (_, index) => ({ date: dateAt(index), professionals: [] })),
	});
	const emptyDay = await getAvailability(target, "serviceId="+serviceId+"&date="+tuesday, receptionToken);
	expect(emptyDay.status).toBe(200);
	expect(await emptyDay.json()).toEqual({ professionalId: firstProfessionalId, serviceId, date: tuesday, starts: [] });

});

it("subtracts cross-date blocks and reservations for another service", async () => {

	expect((await post("/professionals/"+firstProfessionalId+"/blocks", administratorToken, {
		startAt: monday+"T05:59:00.000Z", endAt: monday+"T06:00:30.000Z",
	})).status).toBe(201);
	expect((await post("/professionals/"+secondProfessionalId+"/blocks", administratorToken, {
		startAt: wednesday+"T06:00:30.000Z", endAt: wednesday+"T06:01:00.000Z",
	})).status).toBe(201);
	expect((await post("/appointments", receptionToken, {
		professionalId: firstProfessionalId, serviceId: otherServiceId, patientId, startAt: firstStarts[3],
	})).status).toBe(201);
	const first = await getAvailability(professionalPath(firstProfessionalId), professionalQuery, receptionToken);
	expect(first.status).toBe(200);
	expect(await first.json()).toEqual({
		professionalId: firstProfessionalId, serviceId, date: monday, starts: [firstStarts[1], firstStarts[4]],
	});
	const second = await getAvailability(professionalPath(secondProfessionalId), "serviceId="+serviceId+"&date="+tuesday, receptionToken);
	expect(second.status).toBe(200);
	expect(await second.json()).toEqual({
		professionalId: secondProfessionalId, serviceId, date: tuesday, starts: secondTuesdayStarts.slice(0, 2),
	});

});

it("keeps availability coherent across dates and professionals during a concurrent reschedule", async () => {

	const path = servicePath(serviceId);
	const available = await getAvailability(path, serviceQuery, receptionToken);
	expect(available.status).toBe(200);
	expect(await available.json()).toEqual(expectedRange(firstStarts, secondTuesdayStarts));

	const booked = await post("/appointments", administratorToken, {
		professionalId: firstProfessionalId, serviceId, patientId, startAt: firstStarts[2],
	});
	expect(booked.status).toBe(201);
	const { appointmentId } = await booked.json();
	const reserved = await getAvailability(path, serviceQuery, receptionToken);
	expect(reserved.status).toBe(200);
	const before = expectedRange([firstStarts[0], firstStarts[1], firstStarts[4]], secondTuesdayStarts);
	expect(await reserved.json()).toEqual(before);

	const gate = await setup.connect();
	let reading: Promise<Response> | undefined;
	try {

		await gate.query("BEGIN");
		const { rows: [{ pid }] } = await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
		await gate.query("SELECT 1 FROM public.users WHERE user_id = $1 FOR NO KEY UPDATE", [actor.userId]);
		reading = getAvailability(path, serviceQuery, receptionToken);
		await vi.waitFor(async () => {

			const { rows } = await setup.query(
				"SELECT 1 FROM pg_stat_activity WHERE $1::integer = ANY(pg_blocking_pids(pid)) AND query LIKE '%lock_user_for_share%'",
				[pid],
			);
			expect(rows).toHaveLength(1);

		}, { interval: 10, timeout: 800 });
		const moved = await post("/appointments/"+appointmentId+"/reschedule", administratorToken, {
			professionalId: secondProfessionalId, startAt: secondTuesdayStarts[0],
		});
		expect(moved.status).toBe(201);

	} finally {
		await gate.query("ROLLBACK");
		gate.release();
		await reading;
	}
	const snapshot = await reading;
	expect(snapshot.status).toBe(200);
	expect(await snapshot.json()).toEqual(before);

	const latest = await getAvailability(path, serviceQuery, receptionToken);
	expect(latest.status).toBe(200);
	expect(await latest.json()).toEqual(expectedRange(firstStarts, secondTuesdayStarts.slice(1)));

});
