import { randomUUID } from "node:crypto";
import { decodeJwt } from "jose";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Appointment, Clinic } from "../../src/generated/prisma/client.js";

const apiUrl = process.env.APPOINTMENT_QUERY_TEST_API_URL;
const setupUrl = process.env.APPOINTMENT_QUERY_TEST_DATABASE_SETUP_URL;
const administratorToken = process.env.APPOINTMENT_QUERY_TEST_ADMIN_TOKEN;
const receptionToken = process.env.APPOINTMENT_QUERY_TEST_RECEPTION_TOKEN;
const professionalToken = process.env.APPOINTMENT_QUERY_TEST_PROFESSIONAL_TOKEN;
const platformToken = process.env.APPOINTMENT_QUERY_TEST_PLATFORM_TOKEN;
if(!apiUrl || !setupUrl || !administratorToken || !receptionToken || !professionalToken || !platformToken) {
	throw new Error("Configure the appointment query test API, disposable database setup URL, and Keycloak tokens");
}

type ClinicFixture = Pick<Appointment, "clinicId" | "patientId" | "professionalId" | "serviceId"> & Pick<Clinic, "timeZone"> & {
	identityId: string;
	durationMinutes: number;
	cancelledByUserId: string;
};

const setup = new Pool({ connectionString: setupUrl });
const patientIds = [randomUUID(), randomUUID()];
let local: ClinicFixture;
let foreign: ClinicFixture;

const getCounts = (token = administratorToken, query = "from=2034-06-30&to=2034-07-01") => {
	const url = new URL("/appointments/counts", apiUrl);
	url.search = query;

	return fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
};

const createAppointment = async (
	clinic: ClinicFixture,
	startAt: string,
	state: Appointment["state"] = "reserved",
	previousAppointmentId?: string,
) => {

	const appointmentId = randomUUID();
	const endAt = new Date(Date.parse(startAt)+clinic.durationMinutes*60_000);
	const cancelled = state === "cancelled";
	await setup.query(
		`INSERT INTO public.appointments (appointment_id, clinic_id, patient_id, professional_id, service_id,
		        start_at, end_at, state, previous_appointment_id, cancelled_by_user_id, cancellation_reason)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
		[appointmentId, clinic.clinicId, clinic.patientId, clinic.professionalId, clinic.serviceId,
			startAt, endAt, state, previousAppointmentId,
			cancelled ? clinic.cancelledByUserId : null, cancelled ? "Synthetic cancellation" : null],
	);

	return appointmentId;

};

beforeAll(async () => {

	const { rows } = await setup.query<Omit<ClinicFixture, "patientId">>(
		`SELECT offered.clinic_id AS "clinicId", clinic.time_zone AS "timeZone",
		        offered.professional_id AS "professionalId", offered.service_id AS "serviceId",
		        service.duration_minutes AS "durationMinutes", reception.identity_id AS "identityId",
		        reception.user_id AS "cancelledByUserId"
		 FROM public.professional_services AS offered
		 JOIN public.clinics AS clinic USING (clinic_id)
		 JOIN public.services AS service USING (clinic_id, service_id)
		 JOIN public.users AS reception USING (clinic_id)
		 WHERE reception.role = 'reception' AND service.duration_minutes = 30
		 ORDER BY offered.clinic_id, offered.professional_id, offered.service_id`,
	);
	const receptionIdentityId = decodeJwt(receptionToken).sub;
	const own = rows.find((clinic) => clinic.identityId === receptionIdentityId)!;
	expect(own).toBeDefined();
	const other = rows.find((clinic) => clinic.clinicId !== own.clinicId)!;
	expect(other).toBeDefined();
	local = { ...own, patientId: patientIds[0] };
	foreign = { ...other, patientId: patientIds[1] };
	expect(local.timeZone).toBe("America/Costa_Rica");
	await setup.query(
		`INSERT INTO public.patients (patient_id, clinic_id, identification, name, date_of_birth, email)
		 SELECT id, clinic, id::text, 'Synthetic Count Patient', DATE '1990-01-01', 'counts@example.test'
		 FROM unnest($1::uuid[], $2::uuid[]) AS patient(id, clinic)`,
		[patientIds, [local.clinicId, foreign.clinicId]],
	);

	await createAppointment(local, "2034-06-30T05:45:00.000Z", "attended");
	await createAppointment(local, "2034-06-30T06:00:00.000Z");
	await createAppointment(local, "2034-06-30T12:00:00.000Z", "attended");
	await createAppointment(local, "2034-06-30T13:00:00.000Z", "absent");
	const originalId = await createAppointment(local, "2034-06-30T14:00:00.000Z", "rescheduled");
	await createAppointment(local, "2034-06-30T15:00:00.000Z", "cancelled");
	await createAppointment(local, "2034-07-01T12:00:00.000Z", "reserved", originalId);
	await createAppointment(local, "2034-07-02T05:45:00.000Z");
	await createAppointment(local, "2034-07-02T06:00:00.000Z", "attended");
	await createAppointment(foreign, "2034-06-30T10:00:00.000Z");
	await createAppointment(foreign, "2034-06-30T11:00:00.000Z");
	await createAppointment(foreign, "2034-06-30T12:00:00.000Z");

});

afterAll(async () => {

	try {
		await setup.query("DELETE FROM public.appointments WHERE patient_id = ANY($1::uuid[])", [patientIds]);
		await setup.query("DELETE FROM public.patients WHERE patient_id = ANY($1::uuid[])", [patientIds]);
	} finally {
		await setup.end();
	}

});

it("requires a valid token and the clinic administrator role for appointment counts", async () => {

	expect((await getCounts("")).status).toBe(401);
	expect((await getCounts("invalid-token")).status).toBe(401);
	for(const token of [receptionToken, professionalToken, platformToken]) {
		expect((await getCounts(token)).status).toBe(403);
	}

});

it("counts all states within the inclusive local range and authenticated clinic", async () => {

	const response = await getCounts();
	expect(response.status).toBe(200);
	expect(response.headers.get("Cache-Control")).toBe("no-store");
	expect(await response.json()).toEqual({
		counts: { reserved: 3, attended: 1, absent: 1, cancelled: 1, rescheduled: 1 },
	});
	const lastDay = await getCounts(administratorToken, "from=2034-07-01&to=2034-07-01");
	expect(lastDay.status).toBe(200);
	expect(await lastDay.json()).toEqual({
		counts: { reserved: 2, attended: 0, absent: 0, cancelled: 0, rescheduled: 0 },
	});
	const wholeYear = await getCounts(administratorToken, "from=2034-01-01&to=2034-12-31");
	expect(wholeYear.status).toBe(200);
	expect(await wholeYear.json()).toEqual({
		counts: { reserved: 3, attended: 3, absent: 1, cancelled: 1, rescheduled: 1 },
	});

});

it("returns all five states with zero counts for a valid empty range", async () => {

	const response = await getCounts(administratorToken, "from=2092-02-29&to=2092-02-29");
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({
		counts: { reserved: 0, attended: 0, absent: 0, cancelled: 0, rescheduled: 0 },
	});

});

it("rejects invalid count ranges, repeated parameters, and clinic overrides", async () => {

	const invalidQueries = [
		"", "from=2034-06-30", "to=2034-07-01", "from=&to=2034-07-01",
		"from=2034-02-29&to=2034-07-01", "from=2034-06-30&to=2034-06-31", "from=0000-01-01&to=2034-07-01",
		"from=2034-07-01&to=2034-06-30", "from=2034-6-30&to=2034-07-01", "from=2034-06-30T00:00:00Z&to=2034-07-01",
		"from=2034-06-30&from=2034-06-30&to=2034-07-01", "from=2034-06-30&to=2034-07-01&to=2034-07-01",
		`from=2034-06-30&to=2034-07-01&clinicId=${foreign.clinicId}`,
		`from=2034-06-30&to=2034-07-01&professionalId=${local.professionalId}`,
		"from=2034-06-30&to=2034-07-01&state=reserved",
	];
	for(const query of invalidQueries) {
		expect((await getCounts(administratorToken, query)).status, query).toBe(400);
	}

});

it.each([
	{
		name: "counts starts across a 23-hour local day", timeZone: "America/New_York", date: "2031-03-09",
		start: "2031-03-09T05:00:00.000Z", end: "2031-03-10T04:00:00.000Z",
	},
	{
		name: "counts starts across a 25-hour day with a repeated midnight", timeZone: "America/Havana", date: "2032-11-07",
		start: "2032-11-07T04:00:00.000Z", end: "2032-11-08T05:00:00.000Z",
	},
])("$name", async ({ timeZone, date, start, end }) => {

	await setup.query("UPDATE public.clinics SET time_zone = $1 WHERE clinic_id = $2", [timeZone, local.clinicId]);
	try {

		await createAppointment(local, new Date(Date.parse(start)-30*60_000).toISOString());
		await createAppointment(local, start);
		await createAppointment(local, new Date(Date.parse(start)+60*60_000).toISOString());
		await createAppointment(local, new Date(Date.parse(end)-30*60_000).toISOString());
		await createAppointment(local, end);
		const response = await getCounts(administratorToken, `from=${date}&to=${date}`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			counts: { reserved: 3, attended: 0, absent: 0, cancelled: 0, rescheduled: 0 },
		});

	} finally {
		await setup.query("UPDATE public.clinics SET time_zone = $1 WHERE clinic_id = $2", [local.timeZone, local.clinicId]);
	}

});
