import { randomUUID } from "node:crypto";
import { decodeJwt } from "jose";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Appointment } from "../../src/generated/prisma/client.js";

const apiUrl = process.env.APPOINTMENT_QUERY_TEST_API_URL;
const setupUrl = process.env.APPOINTMENT_QUERY_TEST_DATABASE_SETUP_URL;
const administratorToken = process.env.APPOINTMENT_QUERY_TEST_ADMIN_TOKEN;
const receptionToken = process.env.APPOINTMENT_QUERY_TEST_RECEPTION_TOKEN;
const professionalToken = process.env.APPOINTMENT_QUERY_TEST_PROFESSIONAL_TOKEN;
const platformToken = process.env.APPOINTMENT_QUERY_TEST_PLATFORM_TOKEN;
if(!apiUrl || !setupUrl || !administratorToken || !receptionToken || !professionalToken || !platformToken) {
	throw new Error("Configure the appointment query test API, disposable database setup URL, and Keycloak tokens");
}

const setup = new Pool({ connectionString: setupUrl });
const patientId = randomUUID();
let fixture: {
	clinicId: string;
	timeZone: string;
	professionalId: string;
	otherProfessionalId: string;
	foreignProfessionalId: string;
	serviceId: string;
	durationMinutes: number;
	cancelledByUserId: string;
};

const getAgenda = (path: string, token?: string, query = "date=2030-01-15") => {
	const url = new URL(path, apiUrl);
	url.search = query;

	return fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
};

const createAppointment = async (
	startAt: string,
	fields: Partial<Pick<Appointment, "professionalId" | "state" | "previousAppointmentId">> = {},
) => {

	const { professionalId = fixture.professionalId, state = "attended", previousAppointmentId = null } = fields;
	const appointment = {
		appointmentId: randomUUID(), patientId, professionalId, serviceId: fixture.serviceId,
		startAt, endAt: new Date(Date.parse(startAt)+fixture.durationMinutes*60_000).toISOString(),
		state, previousAppointmentId,
	};
	const cancelled = state === "cancelled";
	await setup.query(
		`INSERT INTO public.appointments (appointment_id, clinic_id, patient_id, professional_id, service_id,
		        start_at, end_at, state, previous_appointment_id, cancelled_by_user_id, cancellation_reason)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
		[appointment.appointmentId, fixture.clinicId, patientId, professionalId, fixture.serviceId,
			startAt, appointment.endAt, state, previousAppointmentId,
			cancelled ? fixture.cancelledByUserId : null, cancelled ? "Synthetic cancellation" : null],
	);

	return appointment;

};

beforeAll(async () => {

	const { rows } = await setup.query<typeof fixture>(
		`SELECT actor.clinic_id AS "clinicId", clinic.time_zone AS "timeZone", own.professional_id AS "professionalId",
		        other.professional_id AS "otherProfessionalId", foreign_professional.professional_id AS "foreignProfessionalId",
		        service.service_id AS "serviceId", service.duration_minutes AS "durationMinutes",
		        reception.user_id AS "cancelledByUserId"
		 FROM public.users AS actor
		 JOIN public.clinics AS clinic USING (clinic_id)
		 JOIN public.professionals AS own USING (clinic_id, user_id)
		 JOIN public.professional_services AS offered USING (clinic_id, professional_id)
		 JOIN public.services AS service USING (clinic_id, service_id)
		 JOIN public.professional_services AS other USING (clinic_id, service_id)
		 JOIN public.professionals AS foreign_professional ON foreign_professional.clinic_id <> actor.clinic_id
		 JOIN public.users AS reception ON reception.clinic_id = actor.clinic_id AND reception.identity_id = $2
		 WHERE actor.identity_id = $1 AND own.professional_id <> other.professional_id AND service.duration_minutes = 30
		 ORDER BY service.service_id, other.professional_id, foreign_professional.professional_id LIMIT 1`,
		[decodeJwt(professionalToken).sub, decodeJwt(receptionToken).sub],
	);
	expect(rows).toHaveLength(1);
	fixture = rows[0];
	expect(fixture.timeZone).toBe("America/Costa_Rica");
	await setup.query(
		`INSERT INTO public.patients (patient_id, clinic_id, identification, name, date_of_birth, email)
		 VALUES ($1::uuid, $2::uuid, $1::uuid::text, 'Synthetic Agenda Patient', DATE '1990-01-01', 'agenda@example.test')`,
		[patientId, fixture.clinicId],
	);

});

afterAll(async () => {

	try {
		await setup.query("DELETE FROM public.appointments WHERE patient_id = $1", [patientId]);
		await setup.query("DELETE FROM public.patients WHERE patient_id = $1", [patientId]);
	} finally {
		await setup.end();
	}

});

it("enforces authentication and the agreed roles on all agenda routes", async () => {

	const receptionPaths = ["/appointments/agenda", `/professionals/${fixture.professionalId}/agenda`];
	const ownPath = "/professionals/me/agenda";
	for(const path of [...receptionPaths, ownPath]) {

		expect((await getAgenda(path)).status).toBe(401);
		expect((await getAgenda(path, "invalid-token")).status).toBe(401);
		expect((await getAgenda(path, administratorToken)).status).toBe(403);
		expect((await getAgenda(path, platformToken)).status).toBe(403);

	}
	for(const path of [...receptionPaths, `/professionals/${fixture.otherProfessionalId}/agenda`]) {
		expect((await getAgenda(path, professionalToken)).status).toBe(403);
	}
	expect((await getAgenda(ownPath, receptionToken)).status).toBe(403);

});

it("returns clinic and scoped professional agendas with all states and local midnight boundaries", async () => {

	const endsAtMidnight = await createAppointment("2030-01-15T05:30:00.000Z");
	const crossesIntoDay = await createAppointment("2030-01-15T05:45:00.000Z");
	const startsAtMidnight = await createAppointment("2030-01-15T06:00:00.000Z");
	const original = await createAppointment("2030-01-15T12:00:00.000Z", { state: "rescheduled" });
	const cancelled = await createAppointment("2030-01-15T12:00:00.000Z", { state: "cancelled" });
	const absent = await createAppointment("2030-01-15T13:00:00.000Z", { state: "absent" });
	const replacement = await createAppointment("2030-01-15T14:00:00.000Z", {
		state: "reserved", professionalId: fixture.otherProfessionalId, previousAppointmentId: original.appointmentId,
	});
	const crossesOutOfDay = await createAppointment("2030-01-16T05:45:00.000Z");
	const startsNextDay = await createAppointment("2030-01-16T06:00:00.000Z");
	const tied = [original, cancelled].sort((left, right) => left.appointmentId.localeCompare(right.appointmentId));
	const appointments = [crossesIntoDay, startsAtMidnight, ...tied, absent, replacement, crossesOutOfDay];
	const ownAppointments = appointments.filter((appointment) => appointment.professionalId === fixture.professionalId);
	const requests = [
		{ path: "/appointments/agenda", token: receptionToken, expected: appointments },
		{ path: `/professionals/${fixture.professionalId}/agenda`, token: receptionToken, expected: ownAppointments },
		{ path: `/professionals/${fixture.otherProfessionalId}/agenda`, token: receptionToken, expected: [replacement] },
		{ path: "/professionals/me/agenda", token: professionalToken, expected: ownAppointments },
	];
	for(const { path, token, expected } of requests) {

		const response = await getAgenda(path, token);
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.json()).toEqual({ appointments: expected });

	}

	const previousDay = await getAgenda("/appointments/agenda", receptionToken, "date=2030-01-14");
	expect(previousDay.status).toBe(200);
	expect(await previousDay.json()).toEqual({ appointments: [endsAtMidnight, crossesIntoDay] });
	const nextDay = await getAgenda("/appointments/agenda", receptionToken, "date=2030-01-16");
	expect(nextDay.status).toBe(200);
	expect(await nextDay.json()).toEqual({ appointments: [crossesOutOfDay, startsNextDay] });

});

it("returns empty clinic and professional agendas for a valid date without appointments", async () => {

	const requests = [
		{ path: "/appointments/agenda", token: receptionToken },
		{ path: `/professionals/${fixture.professionalId}/agenda`, token: receptionToken },
		{ path: "/professionals/me/agenda", token: professionalToken },
	];
	for(const { path, token } of requests) {
		const response = await getAgenda(path, token, "date=2092-02-29");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ appointments: [] });
	}

});

it("hides foreign professional agendas and rejects professional or clinic overrides", async () => {

	const missing = await getAgenda(`/professionals/${randomUUID()}/agenda`, receptionToken);
	const foreign = await getAgenda(`/professionals/${fixture.foreignProfessionalId}/agenda`, receptionToken);
	expect(missing.status).toBe(404);
	expect(foreign.status).toBe(404);
	expect(await foreign.json()).toEqual(await missing.json());
	expect((await getAgenda("/professionals/invalid/agenda", receptionToken)).status).toBe(400);
	expect((await getAgenda("/appointments/agenda", receptionToken, `date=2030-01-15&clinicId=${randomUUID()}`)).status).toBe(400);
	expect((await getAgenda("/professionals/me/agenda", professionalToken,
		`date=2030-01-15&professionalId=${fixture.otherProfessionalId}`)).status).toBe(400);

});

it("rejects missing, malformed, repeated, and unknown agenda date parameters", async () => {

	const invalidQueries = [
		"", "date=", "date=2030-02-29", "date=2030-04-31", "date=2030-13-01", "date=0000-01-01",
		"date=2030-1-15", "date=2030-01-15T00:00:00Z", "date=2030-01-15&date=2030-01-16", "date=2030-01-15&state=reserved",
	];
	const requests = [
		{ path: "/appointments/agenda", token: receptionToken },
		{ path: `/professionals/${fixture.professionalId}/agenda`, token: receptionToken },
		{ path: "/professionals/me/agenda", token: professionalToken },
	];
	for(const { path, token } of requests) {
		for(const query of invalidQueries) {
			expect((await getAgenda(path, token, query)).status, `${path}?${query}`).toBe(400);
		}
	}

});

it.each([
	{
		name: "uses a 23-hour local day", timeZone: "America/New_York", date: "2031-03-09",
		start: "2031-03-09T05:00:00.000Z", end: "2031-03-10T04:00:00.000Z",
	},
	{
		name: "uses a 25-hour local day", timeZone: "America/New_York", date: "2031-11-02",
		start: "2031-11-02T04:00:00.000Z", end: "2031-11-03T05:00:00.000Z",
	},
	{
		name: "includes both occurrences of a repeated local midnight", timeZone: "America/Havana", date: "2032-11-07",
		start: "2032-11-07T04:00:00.000Z", end: "2032-11-08T05:00:00.000Z",
	},
])("$name", async ({ timeZone, date, start, end }) => {

	await setup.query("UPDATE public.clinics SET time_zone = $1 WHERE clinic_id = $2", [timeZone, fixture.clinicId]);
	try {

		await createAppointment(new Date(Date.parse(start)-30*60_000).toISOString());
		const first = await createAppointment(start);
		const second = await createAppointment(new Date(Date.parse(start)+60*60_000).toISOString());
		const last = await createAppointment(new Date(Date.parse(end)-30*60_000).toISOString());
		await createAppointment(end);
		const requests = [
			{ path: "/appointments/agenda", token: receptionToken },
			{ path: `/professionals/${fixture.professionalId}/agenda`, token: receptionToken },
			{ path: "/professionals/me/agenda", token: professionalToken },
		];
		for(const { path, token } of requests) {
			const response = await getAgenda(path, token, `date=${date}`);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ appointments: [first, second, last] });
		}

	} finally {
		await setup.query("UPDATE public.clinics SET time_zone = $1 WHERE clinic_id = $2", [fixture.timeZone, fixture.clinicId]);
	}

});

it("returns an empty agenda for a local date skipped by a time zone transition", async () => {

	await setup.query("UPDATE public.clinics SET time_zone = 'Pacific/Apia' WHERE clinic_id = $1", [fixture.clinicId]);
	try {

		await createAppointment("2011-12-30T09:45:00.000Z");
		const response = await getAgenda("/appointments/agenda", receptionToken, "date=2011-12-30");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ appointments: [] });

	} finally {
		await setup.query("UPDATE public.clinics SET time_zone = $1 WHERE clinic_id = $2", [fixture.timeZone, fixture.clinicId]);
	}

});
