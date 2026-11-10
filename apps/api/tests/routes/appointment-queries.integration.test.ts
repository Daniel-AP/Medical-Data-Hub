import { randomUUID } from "node:crypto";
import { decodeJwt } from "jose";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AppointmentState } from "../../src/generated/prisma/enums.js";

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
const emptyPatientId = randomUUID();
const foreignPatientId = randomUUID();
const patientIds = [patientId, emptyPatientId, foreignPatientId];

type HistoryEntry = {
	appointmentId: string;
	patientId: string;
	professionalId: string;
	serviceId: string;
	startAt: string;
	endAt: string;
	state: AppointmentState;
	previousAppointmentId: string | null;
};

const appointments: HistoryEntry[] = [];
let foreignClinicId: string;

const getHistory = (id: string, token?: string, query = "") => {
	const url = new URL(`/patients/${id}/appointments`, apiUrl);
	url.search = query;

	return fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
};

beforeAll(async () => {

	const { rows: [fixture] } = await setup.query<{
		clinicId: string;
		professionalId: string;
		otherProfessionalId: string;
		serviceId: string;
		durationMinutes: number;
		foreignClinicId: string;
		cancelledByUserId: string;
	}>(
		`SELECT actor.clinic_id AS "clinicId", own.professional_id AS "professionalId",
		        other.professional_id AS "otherProfessionalId", service.service_id AS "serviceId",
		        service.duration_minutes AS "durationMinutes", foreign_clinic.clinic_id AS "foreignClinicId",
		        reception.user_id AS "cancelledByUserId"
		 FROM public.users AS actor
		 JOIN public.professionals AS own USING (clinic_id, user_id)
		 JOIN public.professional_services AS offered USING (clinic_id, professional_id)
		 JOIN public.services AS service USING (clinic_id, service_id)
		 JOIN public.professional_services AS other USING (clinic_id, service_id)
		 JOIN public.users AS reception ON reception.clinic_id = actor.clinic_id AND reception.identity_id = $2
		 JOIN public.clinics AS foreign_clinic ON foreign_clinic.clinic_id <> actor.clinic_id
		 WHERE actor.identity_id = $1 AND own.professional_id <> other.professional_id
		 ORDER BY service.service_id, other.professional_id, foreign_clinic.clinic_id LIMIT 1`,
		[decodeJwt(professionalToken).sub, decodeJwt(receptionToken).sub],
	);
	expect(fixture).toBeDefined();
	const { clinicId, professionalId, otherProfessionalId, serviceId, durationMinutes, cancelledByUserId } = fixture;
	foreignClinicId = fixture.foreignClinicId;

	await setup.query(
		`INSERT INTO public.patients (patient_id, clinic_id, identification, name, date_of_birth, email)
		 SELECT id, clinic, id::text, 'Synthetic Patient', DATE '1990-01-01', 'patient@example.test'
		 FROM unnest($1::uuid[], $2::uuid[]) AS patient(id, clinic)`,
		[patientIds, [clinicId, clinicId, foreignClinicId]],
	);

	const originalId = randomUUID();
	const cancelledId = randomUUID();
	const fixtures = [
		{ appointmentId: originalId, professionalId, state: "rescheduled", day: 2, previousAppointmentId: null },
		{ appointmentId: cancelledId, professionalId, state: "cancelled", day: 2, previousAppointmentId: null },
		{ appointmentId: randomUUID(), professionalId, state: "absent", day: 3, previousAppointmentId: null },
		{ appointmentId: randomUUID(), professionalId, state: "attended", day: 4, previousAppointmentId: null },
		{ appointmentId: randomUUID(), professionalId: otherProfessionalId, state: "reserved", day: 5, previousAppointmentId: originalId },
	] as const;
	for(const { day, ...appointment } of fixtures) {

		const startAt = new Date(Date.UTC(2030, 0, day, 10));
		const endAt = new Date(startAt.getTime()+durationMinutes*60_000);
		const cancelled = appointment.state === "cancelled";
		await setup.query(
			`INSERT INTO public.appointments (appointment_id, clinic_id, patient_id, professional_id, service_id,
			        start_at, end_at, state, previous_appointment_id, cancelled_by_user_id, cancellation_reason)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
			[appointment.appointmentId, clinicId, patientId, appointment.professionalId, serviceId, startAt, endAt,
				appointment.state, appointment.previousAppointmentId, cancelled ? cancelledByUserId : null,
				cancelled ? "Synthetic cancellation" : null],
		);
		appointments.push({ ...appointment, patientId, serviceId, startAt: startAt.toISOString(), endAt: endAt.toISOString() });

	}

	appointments.sort((left, right) =>
		right.startAt.localeCompare(left.startAt) || left.appointmentId.localeCompare(right.appointmentId),
	);

});

afterAll(async () => {

	try {
		await setup.query("DELETE FROM public.appointments WHERE patient_id = $1", [patientId]);
		await setup.query("DELETE FROM public.patients WHERE patient_id = ANY($1::uuid[])", [patientIds]);
	} finally {
		await setup.end();
	}

});

it("requires a valid token and rejects the platform administrator", async () => {
	expect((await getHistory(patientId)).status).toBe(401);
	expect((await getHistory(patientId, "invalid-token")).status).toBe(401);
	expect((await getHistory(patientId, platformToken)).status).toBe(403);
});

it("returns complete ordered appointment metadata to all permitted clinic roles", async () => {

	for(const token of [administratorToken, receptionToken, professionalToken]) {
		const response = await getHistory(patientId, token);
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.json()).toEqual({ appointments });
	}

});

it("returns an empty history for an existing patient without appointments", async () => {
	const response = await getHistory(emptyPatientId, receptionToken);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ appointments: [] });
});

it("returns the same not-found response for missing and foreign patients", async () => {

	const missing = await getHistory(randomUUID(), receptionToken);
	const foreign = await getHistory(foreignPatientId, receptionToken);
	expect(missing.status).toBe(404);
	expect(foreign.status).toBe(404);
	expect(await foreign.json()).toEqual(await missing.json());

});

it("rejects an invalid patient identifier and a clinic override", async () => {
	expect((await getHistory("invalid", receptionToken)).status).toBe(400);
	expect((await getHistory(foreignPatientId, receptionToken, `clinicId=${foreignClinicId}`)).status).toBe(400);
});
