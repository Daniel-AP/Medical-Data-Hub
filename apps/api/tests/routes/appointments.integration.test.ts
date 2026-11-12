import { randomUUID } from "node:crypto";
import { decodeJwt } from "jose";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const apiUrl = process.env.APPOINTMENT_TEST_API_URL;
const setupUrl = process.env.APPOINTMENT_TEST_DATABASE_SETUP_URL;
const administratorToken = process.env.APPOINTMENT_TEST_ADMIN_TOKEN;
const receptionToken = process.env.APPOINTMENT_TEST_RECEPTION_TOKEN;
const professionalToken = process.env.APPOINTMENT_TEST_PROFESSIONAL_TOKEN;
const platformToken = process.env.APPOINTMENT_TEST_PLATFORM_TOKEN;
if(!apiUrl || !setupUrl || !administratorToken || !receptionToken || !professionalToken || !platformToken) {
	throw new Error("Configure the appointment test API, disposable database, and Keycloak tokens");
}

const setup = new Pool({ connectionString: setupUrl });
const professionalId = randomUUID();
const userId = randomUUID();
let patientId: string;
const serviceId = randomUUID();
const otherProfessionalId = randomUUID();
const otherUserId = randomUUID();
let otherPatientId: string;
let otherServiceId: string;
const professionalIds = [professionalId, otherProfessionalId];
const startAt = "2035-01-08T14:00:00.000Z";
let clinic: { clinicId: string; actorUserId: string; specialtyId: string; durationMinutes: number };

const bookAppointment = (body: unknown = { patientId, professionalId, serviceId, startAt }, token = receptionToken) => {

	return fetch(new URL("/appointments", apiUrl), {
		method: "POST",
		headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(body),
	});

};

const rescheduleAppointment = (appointmentId: string, body: unknown = { professionalId: otherProfessionalId, startAt }, token = receptionToken) => {

	return fetch(new URL(`/appointments/${appointmentId}/reschedule`, apiUrl), {
		method: "POST",
		headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(body),
	});

};

const cancelAppointment = (appointmentId: string, body: unknown = { cancellationReason: "Synthetic cancellation" }, token = receptionToken) => {

	return fetch(new URL(`/appointments/${appointmentId}/cancel`, apiUrl), {
		method: "POST",
		headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(body),
	});

};

const readVersion = async () => {
	const { rows: [row] } = await setup.query("SELECT version FROM public.clinic_availability_versions WHERE clinic_id = $1", [clinic.clinicId]);

	return BigInt(row.version);
};

const waitForWriters = (count: number) => vi.waitFor(async () => {

	const { rows: [row] } = await setup.query("SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE usename = 'medical_data_hub_api' AND wait_event_type = 'Lock'");
	expect(row.count).toBe(count);

}, { interval: 10, timeout: 800 });

beforeAll(async () => {

	const { rows: [row] } = await setup.query<typeof clinic & { serviceId: string }>(
		`SELECT users.clinic_id AS "clinicId", users.user_id AS "actorUserId", services.specialty_id AS "specialtyId",
		        services.duration_minutes AS "durationMinutes", services.service_id AS "serviceId"
		 FROM public.users JOIN public.services USING (clinic_id) WHERE identity_id = $1 LIMIT 1`,
		[decodeJwt(receptionToken).sub],
	);
	clinic = row;
	otherServiceId = row.serviceId;
	const { rows: patients } = await setup.query("SELECT patient_id FROM public.patients WHERE clinic_id = $1 ORDER BY patient_id LIMIT 2", [clinic.clinicId]);
	[patientId, otherPatientId] = patients.map((patient) => patient.patient_id);
	await setup.query(
		"INSERT INTO public.services (service_id, clinic_id, name, duration_minutes, specialty_id) VALUES ($1, $2, $3, $4, $5)",
		[serviceId, clinic.clinicId, `Synthetic booking ${serviceId}`, clinic.durationMinutes, clinic.specialtyId],
	);
	for(const [targetProfessionalId, targetUserId] of [
		[professionalId, userId],
		[otherProfessionalId, otherUserId],
	]) {

		await setup.query(
			"INSERT INTO public.users (user_id, identity_id, clinic_id, role) VALUES ($1, $2, $3, 'healthcare_professional')",
			[targetUserId, `synthetic-booking-${targetUserId}`, clinic.clinicId],
		);
		await setup.query(
			"INSERT INTO public.professionals (professional_id, clinic_id, user_id, specialty_id) VALUES ($1, $2, $3, $4)",
			[targetProfessionalId, clinic.clinicId, targetUserId, clinic.specialtyId],
		);
		await setup.query(
			`INSERT INTO public.professional_schedules (clinic_id, professional_id, weekday, start_minute, end_minute)
			 SELECT $1, $2, weekday, 0, 1440 FROM generate_series(1, 7) AS weekday`,
			[clinic.clinicId, targetProfessionalId],
		);

	}
	await setup.query(
		`INSERT INTO public.professional_services (clinic_id, professional_id, service_id)
		 SELECT $1, professional_id, service_id FROM unnest($2::uuid[]) AS professional_id CROSS JOIN unnest($3::uuid[]) AS service_id`,
		[clinic.clinicId, professionalIds, [serviceId, otherServiceId]],
	);

});

afterEach(async () => {

	await setup.query("DELETE FROM public.appointments WHERE professional_id = ANY($1::uuid[])", [professionalIds]);
	await setup.query("DELETE FROM public.professional_blocks WHERE professional_id = ANY($1::uuid[])", [professionalIds]);
	await setup.query("DELETE FROM public.professional_schedules WHERE professional_id = ANY($1::uuid[])", [professionalIds]);
	await setup.query("INSERT INTO public.professional_schedules (clinic_id, professional_id, weekday, start_minute, end_minute) SELECT $1, professional_id, weekday, 0, 1440 FROM unnest($2::uuid[]) AS professional_id CROSS JOIN generate_series(1, 7) AS weekday", [clinic.clinicId, professionalIds]);
	await setup.query("UPDATE public.services SET is_active = true, specialty_id = $2 WHERE service_id = $1", [serviceId, clinic.specialtyId]);
	await setup.query("UPDATE public.professional_services SET is_active = true WHERE professional_id = ANY($1::uuid[])", [professionalIds]);
	await setup.query("UPDATE public.users SET is_active = true, role = 'healthcare_professional' WHERE user_id = ANY($1::uuid[])", [[userId, otherUserId]]);

});

afterAll(async () => {

	await setup.query("DELETE FROM public.professional_schedules WHERE professional_id = ANY($1::uuid[])", [professionalIds]);
	await setup.query("DELETE FROM public.professional_services WHERE professional_id = ANY($1::uuid[])", [professionalIds]);
	await setup.query("DELETE FROM public.professionals WHERE professional_id = ANY($1::uuid[])", [professionalIds]);
	await setup.query("DELETE FROM public.users WHERE user_id = ANY($1::uuid[])", [[userId, otherUserId]]);
	await setup.query("DELETE FROM public.services WHERE service_id = $1", [serviceId]);
	await setup.end();

});

it("allows clinic administrators to book appointments", async () => {
	expect((await bookAppointment(undefined, administratorToken)).status).toBe(201);
});

it("requires a permitted token to book appointments", async () => {

	for(const [token, status] of [["", 401], [professionalToken, 403], [platformToken, 403]] as const) {
		expect((await bookAppointment(undefined, token)).status).toBe(status);
	}

});

it("rejects invalid booking fields and client-supplied ownership or timing fields", async () => {

	const registration = { patientId, professionalId, serviceId, startAt };
	for(const changes of [
		{ patientId: undefined }, { professionalId: "invalid" }, { serviceId: null }, { startAt: undefined },
		{ startAt: "2035-01-08T14:00" },
		{ startAt: "2035-01-08T14:00:01Z" }, { startAt: "2000-01-01T14:00Z" },
		{ clinicId: clinic.clinicId }, { endAt: "2035-01-08T15:00Z" },
	]) {
		expect((await bookAppointment({ ...registration, ...changes })).status).toBe(400);
	}

});

it("hides missing and foreign booking resources with the same not-found response", async () => {

	const { rows: [foreign] } = await setup.query(
		`SELECT professional.professional_id AS "professionalId", service.service_id AS "serviceId", patient.patient_id AS "patientId"
		 FROM public.professionals AS professional JOIN public.services AS service USING (clinic_id)
		 JOIN public.patients AS patient USING (clinic_id) WHERE professional.clinic_id <> $1 LIMIT 1`,
		[clinic.clinicId],
	);
	for(const field of ["patientId", "professionalId", "serviceId"]) {

		for(const id of [randomUUID(), foreign[field]]) {

			const response = await bookAppointment({ patientId, professionalId, serviceId, startAt, [field]: id });
			expect(response.status).toBe(404);

		}

	}

});

it.each([
	{ condition: "inactive service", query: "UPDATE public.services SET is_active = false WHERE service_id = $1", values: [serviceId] },
	{ condition: "inactive association", query: "UPDATE public.professional_services SET is_active = false WHERE professional_id = $1 AND service_id = $2", values: [professionalId, serviceId] },
	{ condition: "inactive user", query: "UPDATE public.users SET is_active = false WHERE user_id = $1", values: [userId] },
	{ condition: "changed user role", query: "UPDATE public.users SET role = 'reception' WHERE user_id = $1", values: [userId] },
	{
		condition: "incompatible specialty",
		query: `UPDATE public.services SET specialty_id = (SELECT specialty_id FROM public.specialties
		        WHERE clinic_id = services.clinic_id AND specialty_id <> services.specialty_id LIMIT 1) WHERE service_id = $1`,
		values: [serviceId],
	},
])("rejects booking with $condition without changing availability", async ({ query, values }) => {

	await setup.query(query, values);
	const version = await readVersion();
	expect((await bookAppointment()).status).toBe(409);
	expect(await readVersion()).toBe(version);

});

it.each(["empty week", "cross-date block", "professional overlap", "patient overlap"])(
	"rejects booking with %s across all services",
	async (conflict) => {

		if(conflict === "empty week") {
			await setup.query("DELETE FROM public.professional_schedules WHERE professional_id = $1", [professionalId]);
		} else if(conflict === "cross-date block") {
			await setup.query("INSERT INTO public.professional_blocks (clinic_id, professional_id, start_at, end_at) VALUES ($1, $2, '2035-01-07 20:00Z', '2035-01-08 14:01Z')", [clinic.clinicId, professionalId]);
		} else {

			await setup.query(
				`INSERT INTO public.appointments (clinic_id, professional_id, patient_id, service_id, start_at, end_at)
				 VALUES ($1, $2, $3, $4, $5::timestamptz-interval '1 minute', $5::timestamptz+($6::int-1)*interval '1 minute')`,
				[clinic.clinicId, conflict === "patient overlap" ? otherProfessionalId : professionalId, conflict === "patient overlap" ? patientId : otherPatientId, otherServiceId, startAt, clinic.durationMinutes],
			);

		}
		const version = await readVersion();
		expect((await bookAppointment()).status).toBe(409);
		expect(await readVersion()).toBe(version);

	},
);

it("allows adjacent reservations and blocks while ignoring final appointment states", async () => {

	await setup.query(
		`INSERT INTO public.appointments (clinic_id, professional_id, patient_id, service_id, start_at, end_at, state, cancelled_by_user_id, cancellation_reason)
		 SELECT $1, $2, $3, $4, $5, $5::timestamptz+$6::int*interval '1 minute', state,
		        CASE WHEN state = 'cancelled' THEN $7::uuid END, CASE WHEN state = 'cancelled' THEN 'Synthetic cancellation' END
		 FROM unnest(ARRAY['attended', 'absent', 'cancelled', 'rescheduled']::public.appointment_state[]) AS state`,
		[clinic.clinicId, professionalId, patientId, serviceId, startAt, clinic.durationMinutes, userId],
	);
	await setup.query(
		`INSERT INTO public.appointments (clinic_id, professional_id, patient_id, service_id, start_at, end_at)
		 VALUES ($1, $2, $3, $4, $5::timestamptz-$6::int*interval '1 minute', $5)`,
		[clinic.clinicId, professionalId, patientId, serviceId, startAt, clinic.durationMinutes],
	);
	await setup.query("INSERT INTO public.professional_blocks (clinic_id, professional_id, start_at, end_at) VALUES ($1, $2, $3::timestamptz+$4::int*interval '1 minute', $3::timestamptz+($4::int+1)*interval '1 minute')", [clinic.clinicId, professionalId, startAt, clinic.durationMinutes]);
	expect((await bookAppointment()).status).toBe(201);

});

it.each(["professional", "patient"])("grants exactly one concurrent booking after waiting for the %s lock", async (resource) => {

	const gate = await setup.connect();
	const version = await readVersion();
	try {

		await gate.query("BEGIN");
		if(resource === "professional") {

			await setup.query("DELETE FROM public.professional_schedules WHERE professional_id = $1", [professionalId]);
			await setup.query(
				"INSERT INTO public.professional_schedules (clinic_id, professional_id, weekday, start_minute, end_minute) VALUES ($1, $2, 1, 480, 480+$3::int)",
				[clinic.clinicId, professionalId, clinic.durationMinutes],
			);
			await gate.query("SELECT 1 FROM public.professionals WHERE professional_id = $1 FOR NO KEY UPDATE", [professionalId]);

		} else {
			await gate.query("SELECT 1 FROM public.patients WHERE patient_id = $1 FOR NO KEY UPDATE", [patientId]);
		}
		const requests = [bookAppointment(), bookAppointment({
			patientId: resource === "professional" ? otherPatientId : patientId,
			professionalId: resource === "patient" ? otherProfessionalId : professionalId, serviceId, startAt,
		})];
		await waitForWriters(2);
		await gate.query("COMMIT");
		expect((await Promise.all(requests)).map((response) => response.status).sort()).toEqual([201, 409]);
		const { rows } = await setup.query("SELECT appointment_id FROM public.appointments WHERE professional_id = ANY($1::uuid[]) AND state = 'reserved'", [professionalIds]);
		expect(rows).toHaveLength(1);
		expect(await readVersion()).toBe(version+1n);

	} finally {
		await gate.query("ROLLBACK");
		gate.release();
	}

});

it.each([
	{ operation: "booking", failure: "missing" }, { operation: "booking", failure: "overflowed" },
	{ operation: "rescheduling", failure: "missing" }, { operation: "rescheduling", failure: "overflowed" },
	{ operation: "cancellation", failure: "missing" }, { operation: "cancellation", failure: "overflowed" },
])("rolls back $operation when the availability version is $failure", async ({ operation, failure }) => {

	const original = operation === "booking" ? undefined : await (await bookAppointment()).json();
	const version = await readVersion();
	try {

		if(failure === "missing") {
			await setup.query("DELETE FROM public.clinic_availability_versions WHERE clinic_id = $1", [clinic.clinicId]);
		} else {
			await setup.query("UPDATE public.clinic_availability_versions SET version = 9223372036854775807 WHERE clinic_id = $1", [clinic.clinicId]);
		}
		let response: Response;
		if(operation === "cancellation") {
			response = await cancelAppointment(original.appointmentId);
		} else if(operation === "rescheduling") {
			response = await rescheduleAppointment(original.appointmentId);
		} else {
			response = await bookAppointment();
		}
		expect(response.status).toBe(500);
		const { rows } = await setup.query("SELECT appointment_id, state FROM public.appointments WHERE professional_id = ANY($1::uuid[])", [professionalIds]);
		expect(rows).toEqual(original ? [{ appointment_id: original.appointmentId, state: "reserved" }] : []);

	} finally {
		await setup.query("INSERT INTO public.clinic_availability_versions (clinic_id, version) VALUES ($1, $2) ON CONFLICT (clinic_id) DO UPDATE SET version = EXCLUDED.version", [clinic.clinicId, version.toString()]);
	}

});

it("reschedules with an inactive service and source user while preserving the replacement chain", async () => {

	const original = await (await bookAppointment()).json();
	await setup.query("UPDATE public.services SET is_active = false WHERE service_id = $1", [serviceId]);
	await setup.query("UPDATE public.users SET is_active = false WHERE user_id = $1", [userId]);
	const version = await readVersion();
	const response = await rescheduleAppointment(original.appointmentId, { professionalId: otherProfessionalId.toUpperCase(), startAt }, administratorToken);
	expect(response.status).toBe(201);
	const replacement = await response.json();
	expect(replacement).toEqual({ appointmentId: expect.any(String) });
	const { rows } = await setup.query(
		`SELECT appointment_id, clinic_id, patient_id, professional_id, service_id, start_at, end_at, state,
		        previous_appointment_id, cancelled_by_user_id, cancellation_reason, xmin::text AS transaction_id
		 FROM public.appointments WHERE professional_id = ANY($1::uuid[]) ORDER BY previous_appointment_id NULLS FIRST`,
		[professionalIds],
	);
	const common = {
		clinic_id: clinic.clinicId, patient_id: patientId, service_id: serviceId, start_at: new Date(startAt),
		end_at: new Date(Date.parse(startAt)+clinic.durationMinutes*60_000), cancelled_by_user_id: null, cancellation_reason: null,
	};
	const availability = (await setup.query("SELECT xmin::text AS transaction_id FROM public.clinic_availability_versions WHERE clinic_id = $1", [clinic.clinicId])).rows[0];
	expect(rows).toEqual([
		{ ...common, appointment_id: original.appointmentId, professional_id: professionalId, state: "rescheduled", previous_appointment_id: null, ...availability },
		{ ...common, appointment_id: replacement.appointmentId, professional_id: otherProfessionalId, state: "reserved", previous_appointment_id: original.appointmentId, ...availability },
	]);
	expect(await readVersion()).toBe(version+1n);
	expect((await rescheduleAppointment(original.appointmentId)).status).toBe(409);
	const next = await rescheduleAppointment(replacement.appointmentId, { professionalId: otherProfessionalId.toUpperCase(), startAt });
	expect(next.status).toBe(201);
	const { rows: [link] } = await setup.query("SELECT previous_appointment_id FROM public.appointments WHERE appointment_id = $1", [(await next.json()).appointmentId]);
	expect(link.previous_appointment_id).toBe(replacement.appointmentId);
	expect(await readVersion()).toBe(version+2n);

});

it("authorizes and validates rescheduling requests without changing the original", async () => {

	const original = await (await bookAppointment()).json();
	for(const [token, status] of [["", 401], [professionalToken, 403], [platformToken, 403]] as const) {
		expect((await rescheduleAppointment(original.appointmentId, undefined, token)).status).toBe(status);
	}
	for(const body of [{ startAt }, { professionalId: "invalid", startAt }, { professionalId, startAt: "2000-01-01T14:00Z" }, { professionalId, startAt: "2035-01-08T14:00:01Z" }, { professionalId, startAt, patientId }]) {
		expect((await rescheduleAppointment(original.appointmentId, body)).status).toBe(400);
	}
	const foreign = (await setup.query("SELECT appointment_id, professional_id FROM public.appointments WHERE clinic_id <> $1 LIMIT 1", [clinic.clinicId])).rows[0];
	for(const id of [randomUUID(), foreign.appointment_id]) {
		expect((await rescheduleAppointment(id)).status).toBe(404);
	}
	for(const id of [randomUUID(), foreign.professional_id]) {
		expect((await rescheduleAppointment(original.appointmentId, { professionalId: id, startAt })).status).toBe(404);
	}
	expect((await setup.query("SELECT state FROM public.appointments WHERE appointment_id = $1", [original.appointmentId])).rows).toEqual([{ state: "reserved" }]);

});

it.each(["professional overlap", "patient overlap", "inactive destination"])("rejects rescheduling with %s and preserves the original", async (conflict) => {

	const original = await (await bookAppointment()).json();
	const destinationStart = new Date(Date.parse(startAt)+clinic.durationMinutes*60_000).toISOString();
	if(conflict === "inactive destination") {
		await setup.query("UPDATE public.users SET is_active = false WHERE user_id = $1", [otherUserId]);
	} else {

		const occupied = await bookAppointment({
			professionalId: conflict === "patient overlap" ? professionalId : otherProfessionalId,
			patientId: conflict === "patient overlap" ? patientId : otherPatientId, serviceId: otherServiceId, startAt: destinationStart,
		});
		expect(occupied.status).toBe(201);

	}
	const version = await readVersion();
	expect((await rescheduleAppointment(original.appointmentId, { professionalId: otherProfessionalId, startAt: destinationStart })).status).toBe(409);
	expect((await setup.query("SELECT state FROM public.appointments WHERE appointment_id = $1", [original.appointmentId])).rows).toEqual([{ state: "reserved" }]);
	expect(await readVersion()).toBe(version);

});

it.each(["booking", "rescheduling"])("grants one destination when rescheduling races with %s", async (competitor) => {

	const original = await (await bookAppointment()).json();
	const gate = await setup.connect();
	const version = await readVersion();
	try {

		await gate.query("BEGIN");
		await gate.query("SELECT 1 FROM public.professionals WHERE professional_id = $1 FOR NO KEY UPDATE", [otherProfessionalId]);
		const moving = rescheduleAppointment(original.appointmentId);
		const competing = competitor === "booking"
			? bookAppointment({ professionalId: otherProfessionalId, patientId: otherPatientId, serviceId, startAt })
			: rescheduleAppointment(original.appointmentId);
		await waitForWriters(2);
		await gate.query("COMMIT");
		const responses = await Promise.all([moving, competing]);
		expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
		const { rows } = await setup.query("SELECT appointment_id FROM public.appointments WHERE professional_id = $1 AND state = 'reserved'", [otherProfessionalId]);
		expect(rows).toHaveLength(1);
		expect(await readVersion()).toBe(version+1n);

	} finally {
		await gate.query("ROLLBACK");
		gate.release();
	}

});

it.each(["attended", "absent"])("rejects appointment changes after a controlled SQL outcome of %s commits", async (state) => {

	const original = await (await bookAppointment()).json();
	await setup.query("UPDATE public.appointments SET start_at = '2000-01-03 14:00Z', end_at = '2000-01-03 14:00Z'::timestamptz+$2::int*interval '1 minute' WHERE appointment_id = $1", [original.appointmentId, clinic.durationMinutes]);
	const gate = await setup.connect();
	const version = await readVersion();
	const requests: Promise<Response>[] = [];
	try {

		await gate.query("BEGIN");
		await gate.query("SELECT * FROM public.lock_user_for_share($1::uuid, $1::uuid)", [clinic.actorUserId]);
		await gate.query("SELECT set_config('app.user_id', $1, true), set_config('app.clinic_id', $2, true)", [clinic.actorUserId, clinic.clinicId]);
		await gate.query("SET LOCAL ROLE reception");
		await gate.query("UPDATE public.appointments SET state = $2::public.appointment_state WHERE appointment_id = $1", [original.appointmentId, state]);
		requests.push(rescheduleAppointment(original.appointmentId), cancelAppointment(original.appointmentId));
		await waitForWriters(2);
		await gate.query("UPDATE public.clinic_availability_versions SET version = version+1 WHERE clinic_id = $1", [clinic.clinicId]);
		await gate.query("COMMIT");
		expect((await Promise.all(requests)).map((response) => response.status)).toEqual([409, 409]);
		expect((await setup.query("SELECT state FROM public.appointments WHERE professional_id = ANY($1::uuid[])", [professionalIds])).rows).toEqual([{ state }]);
		expect(await readVersion()).toBe(version+1n);

	} finally {
		await gate.query("ROLLBACK");
		await Promise.allSettled(requests);
		gate.release();
	}

});

it("cancels a historical replacement without agenda locks and commits its reason and actor", async () => {

	const original = await (await bookAppointment()).json();
	const replacement = await (await rescheduleAppointment(original.appointmentId)).json();
	await setup.query("UPDATE public.appointments SET start_at = '2000-01-03 14:00Z', end_at = '2000-01-03 14:00Z'::timestamptz+$2::int*interval '1 minute' WHERE professional_id = ANY($1::uuid[])", [professionalIds, clinic.durationMinutes]);
	await setup.query("UPDATE public.users SET is_active = false WHERE user_id = $1", [otherUserId]);
	await setup.query("UPDATE public.services SET is_active = false WHERE service_id = $1", [serviceId]);
	const gate = await setup.connect();
	const version = await readVersion();
	const cancellationReason = "  Synthetic cancellation  ";
	try {

		await gate.query("BEGIN");
		await gate.query("SELECT 1 FROM public.users WHERE user_id = $1 FOR NO KEY UPDATE", [otherUserId]);
		await gate.query("SELECT 1 FROM public.services WHERE service_id = $1 FOR NO KEY UPDATE", [serviceId]);
		await gate.query("SELECT 1 FROM public.professionals WHERE professional_id = $1 FOR NO KEY UPDATE", [otherProfessionalId]);
		await gate.query("SELECT 1 FROM public.patients WHERE patient_id = $1 FOR NO KEY UPDATE", [patientId]);
		const response = await cancelAppointment(replacement.appointmentId, { cancellationReason });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(replacement);
		const { rows } = await setup.query("SELECT state, cancellation_reason, cancelled_by_user_id, previous_appointment_id, xmin::text AS transaction_id FROM public.appointments WHERE appointment_id = $1", [replacement.appointmentId]);
		const availability = (await setup.query("SELECT xmin::text AS transaction_id FROM public.clinic_availability_versions WHERE clinic_id = $1", [clinic.clinicId])).rows[0];
		expect(rows).toEqual([{ state: "cancelled", cancellation_reason: cancellationReason, cancelled_by_user_id: clinic.actorUserId, previous_appointment_id: original.appointmentId, ...availability }]);
		expect(await readVersion()).toBe(version+1n);
		expect((await cancelAppointment(original.appointmentId)).status).toBe(409);
		expect((await cancelAppointment(replacement.appointmentId)).status).toBe(409);

	} finally {
		await gate.query("ROLLBACK");
		gate.release();
	}

});

it("authorizes and validates cancellation without exposing foreign appointments", async () => {

	const original = await (await bookAppointment()).json();
	const version = await readVersion();
	for(const [token, status] of [["", 401], [professionalToken, 403], [platformToken, 403]] as const) {
		expect((await cancelAppointment(original.appointmentId, undefined, token)).status).toBe(status);
	}
	for(const body of [{}, { cancellationReason: " " }, { cancellationReason: "\0" }, { cancellationReason: "x".repeat(501) }, { cancellationReason: "Synthetic cancellation", cancelledByUserId: userId }]) {
		expect((await cancelAppointment(original.appointmentId, body)).status).toBe(400);
	}
	expect((await cancelAppointment("invalid")).status).toBe(400);
	const foreign = (await setup.query("SELECT appointment_id FROM public.appointments WHERE clinic_id <> $1 LIMIT 1", [clinic.clinicId])).rows[0];
	for(const id of [randomUUID(), foreign.appointment_id]) {
		expect((await cancelAppointment(id)).status).toBe(404);
	}
	expect(await readVersion()).toBe(version);
	expect((await cancelAppointment(original.appointmentId, { cancellationReason: "x".repeat(500) }, administratorToken)).status).toBe(200);

});

it.each([
	{ first: "cancellation", second: "cancellation" },
	{ first: "cancellation", second: "rescheduling" },
	{ first: "rescheduling", second: "cancellation" },
])("commits only $first when it wins a race against $second", async ({ first, second }) => {

	const original = await (await bookAppointment()).json();
	const gate = await setup.connect();
	const version = await readVersion();
	const requests: Promise<Response>[] = [];
	try {

		await gate.query("BEGIN");
		await gate.query("SELECT 1 FROM public.clinic_availability_versions WHERE clinic_id = $1 FOR NO KEY UPDATE", [clinic.clinicId]);
		const winner = first === "cancellation" ? cancelAppointment(original.appointmentId) : rescheduleAppointment(original.appointmentId);
		requests.push(winner);
		await waitForWriters(1);
		const loser = second === "cancellation" ? cancelAppointment(original.appointmentId) : rescheduleAppointment(original.appointmentId);
		requests.push(loser);
		await waitForWriters(2);
		expect((await setup.query("SELECT state FROM public.appointments WHERE appointment_id = $1", [original.appointmentId])).rows).toEqual([{ state: "reserved" }]);
		await gate.query("COMMIT");
		expect((await winner).status).toBe(first === "cancellation" ? 200 : 201);
		expect((await loser).status).toBe(409);
		expect(await readVersion()).toBe(version+1n);
		const releasedPatientId = first === "cancellation" ? patientId : otherPatientId;
		expect((await bookAppointment({ professionalId, patientId: releasedPatientId, serviceId, startAt })).status).toBe(201);

	} finally {
		await gate.query("ROLLBACK");
		await Promise.allSettled(requests);
		gate.release();
	}

});

it("books a reserved appointment with the protected service duration and one committed availability increment", async () => {

	const version = await readVersion();
	await setup.query("DELETE FROM public.professional_schedules WHERE professional_id = $1", [professionalId]);
	await setup.query(
		`INSERT INTO public.professional_schedules (clinic_id, professional_id, weekday, start_minute, end_minute)
		 VALUES ($1, $2, 1, 1380, 1439), ($1, $2, 1, 1439, 1440), ($1, $2, 2, 0, 1440)`,
		[clinic.clinicId, professionalId],
	);
	const bookingStart = "2035-01-08T23:59-06:00";
	const response = await bookAppointment({ patientId, professionalId, serviceId, startAt: bookingStart });
	expect(response.status).toBe(201);
	const result = await response.json();
	expect(result).toEqual({ appointmentId: expect.any(String) });
	const { rows } = await setup.query(
		`SELECT clinic_id, patient_id, professional_id, service_id, start_at, end_at, state,
		        previous_appointment_id, cancelled_by_user_id, cancellation_reason, xmin::text AS transaction_id
		 FROM public.appointments WHERE appointment_id = $1`,
		[result.appointmentId],
	);
	const { rows: [availability] } = await setup.query("SELECT version, xmin::text AS transaction_id FROM public.clinic_availability_versions WHERE clinic_id = $1", [clinic.clinicId]);
	expect(rows).toEqual([{
		clinic_id: clinic.clinicId, patient_id: patientId, professional_id: professionalId, service_id: serviceId,
		start_at: new Date(bookingStart), end_at: new Date(Date.parse(bookingStart)+clinic.durationMinutes*60_000), state: "reserved",
		previous_appointment_id: null, cancelled_by_user_id: null, cancellation_reason: null, transaction_id: availability.transaction_id,
	}]);
	expect(BigInt(availability.version)).toBe(version+1n);

});
