import type { Appointment, Clinic, Professional, Service } from "../generated/prisma/client.js";
import { UserRole } from "../generated/prisma/enums.js";
import type { Authentication } from "../middleware/types.js";
import { isScheduleCovered } from "../schedules/coverage.js";
import type { ScheduleInterval } from "../schedules/types.js";
import { incrementAvailabilityVersion } from "./availability-versions.js";
import { runAuthorizedTransaction } from "./transactions/authorized-transaction.js";

type AppointmentRegistration = Pick<Appointment, "patientId" | "professionalId" | "serviceId" | "startAt">;
type BookingService = Pick<Service, "durationMinutes" | "specialtyId" | "isActive">;

export const createAppointment = (authentication: Authentication, registration: AppointmentRegistration) => {

	return runAuthorizedTransaction(authentication, { name: "createAppointment", professionalId: registration.professionalId }, async (transaction, actor) => {

		const isReception = actor.role === UserRole.reception;
		const serviceLock = isReception
			? `SELECT duration_minutes AS "durationMinutes", specialty_id AS "specialtyId", is_active AS "isActive" FROM public.lock_service_for_share($1::uuid)`
			: `SELECT duration_minutes AS "durationMinutes", specialty_id AS "specialtyId", is_active AS "isActive" FROM public.services WHERE service_id = $1::uuid FOR SHARE`;
		const { rows: [service] } = await transaction.query<BookingService>(serviceLock, [registration.serviceId]);
		if(!service) {
			throw Object.assign(new Error("Service not found"), { status: 404 });
		}

		const professionalLock = isReception
			? `SELECT professional_id AS "professionalId", specialty_id AS "specialtyId" FROM public.lock_professional_for_no_key_update($1::uuid)`
			: `SELECT professional_id AS "professionalId", specialty_id AS "specialtyId" FROM public.professionals WHERE professional_id = $1::uuid FOR NO KEY UPDATE`;
		const { rows: [professional] } = await transaction.query<Pick<Professional, "professionalId" | "specialtyId">>(professionalLock, [registration.professionalId]);
		if(!professional) {
			throw Object.assign(new Error("Professional not found"), { status: 404 });
		}

		const { rows: [patient] } = await transaction.query<Pick<Appointment, "patientId">>(
			`SELECT patient_id AS "patientId" FROM public.patients WHERE patient_id = $1::uuid FOR NO KEY UPDATE`,
			[registration.patientId],
		);
		if(!patient) {
			throw Object.assign(new Error("Patient not found"), { status: 404 });
		}

		const { rows: [association] } = await transaction.query(
			`SELECT 1 FROM public.professional_services WHERE professional_id = $1::uuid AND service_id = $2::uuid AND is_active`,
			[professional.professionalId, registration.serviceId],
		);
		const user = actor.destinationUser!;
		const isEligible = service.isActive && user.isActive && user.role === "healthcare_professional" &&
			professional.specialtyId === service.specialtyId && association !== undefined;
		if(!isEligible) {
			throw Object.assign(new Error("Service or professional is not eligible for booking"), { status: 409 });
		}

		const endAt = new Date(registration.startAt.getTime()+service.durationMinutes*60_000);
		const { rows: [clinic] } = await transaction.query<Pick<Clinic, "timeZone">>(
			`SELECT time_zone AS "timeZone" FROM public.clinics WHERE clinic_id = $1::uuid`,
			[actor.clinicId],
		);
		const { rows: week } = await transaction.query<ScheduleInterval>(
			`SELECT weekday, start_minute AS "startMinute", end_minute AS "endMinute" FROM public.professional_schedules WHERE professional_id = $1::uuid`,
			[professional.professionalId],
		);
		if(!isScheduleCovered(week, registration.startAt, endAt, clinic.timeZone)) {
			throw Object.assign(new Error("Appointment is outside the professional schedule"), { status: 409 });
		}

		const { rows: [occupation] } = await transaction.query<{ conflicts: boolean }>(
			`SELECT EXISTS (
			     SELECT 1 FROM public.professional_blocks WHERE professional_id = $1::uuid
			       AND start_at < $4::timestamptz AND end_at > $3::timestamptz
			 ) OR EXISTS (
			     SELECT 1 FROM public.appointments WHERE state = 'reserved'
			       AND (professional_id = $1::uuid OR patient_id = $2::uuid)
			       AND start_at < $4::timestamptz AND end_at > $3::timestamptz
			 ) AS conflicts`,
			[professional.professionalId, patient.patientId, registration.startAt, endAt],
		);
		if(occupation.conflicts) {
			throw Object.assign(new Error("Appointment overlaps reserved time or a block"), { status: 409 });
		}

		const { rows: [appointment] } = await transaction.query<Pick<Appointment, "appointmentId">>(
			`INSERT INTO public.appointments (clinic_id, professional_id, patient_id, service_id, start_at, end_at)
			 SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz, $6::timestamptz
			 WHERE $5::timestamptz > clock_timestamp() AND EXTRACT(SECOND FROM $5::timestamptz AT TIME ZONE 'UTC') = 0
			 RETURNING appointment_id AS "appointmentId"`,
			[actor.clinicId, professional.professionalId, patient.patientId, registration.serviceId, registration.startAt, endAt],
		);
		if(!appointment) {
			throw Object.assign(new Error("Appointment start must be a future whole UTC minute"), { status: 400 });
		}
		await incrementAvailabilityVersion(transaction, actor.clinicId!);

		return appointment;

	});

};
