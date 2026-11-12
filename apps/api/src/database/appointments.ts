import type { Appointment, Clinic, Professional, Service, User } from "../generated/prisma/client.js";
import { UserRole } from "../generated/prisma/enums.js";
import type { Authentication } from "../middleware/types.js";
import { isScheduleCovered } from "./schedule-coverage.js";
import { incrementAvailabilityVersion } from "./availability-versions.js";
import { runAuthorizedTransaction } from "./authorization.js";
import type { ScheduleInterval, TransactionClient } from "./types.js";

type AppointmentRegistration = Pick<Appointment, "patientId" | "professionalId" | "serviceId" | "startAt">;
type AppointmentDestination = Pick<AppointmentRegistration, "professionalId" | "startAt">;
type AppointmentService = Pick<Service, "durationMinutes" | "specialtyId" | "isActive">;
type AppointmentProfessional = Pick<Professional, "professionalId" | "specialtyId">;
type AppointmentEligibility = {
	service: AppointmentService;
	professional: AppointmentProfessional;
	user: Pick<User, "isActive"> & { role: string };
};

const lockService = async (transaction: TransactionClient, serviceId: string, isReception: boolean) => {

	const query = isReception
		? `SELECT duration_minutes AS "durationMinutes", specialty_id AS "specialtyId", is_active AS "isActive" FROM public.lock_service_for_share($1::uuid)`
		: `SELECT duration_minutes AS "durationMinutes", specialty_id AS "specialtyId", is_active AS "isActive" FROM public.services WHERE service_id = $1::uuid FOR SHARE`;
	const { rows: [service] } = await transaction.query<AppointmentService>(query, [serviceId]);
	if(!service) {
		throw Object.assign(new Error("Service not found"), { status: 404 });
	}

	return service;

};

const lockProfessional = async (transaction: TransactionClient, professionalId: string, isReception: boolean) => {

	const query = isReception
		? `SELECT professional_id AS "professionalId", specialty_id AS "specialtyId" FROM public.lock_professional_for_no_key_update($1::uuid)`
		: `SELECT professional_id AS "professionalId", specialty_id AS "specialtyId" FROM public.professionals WHERE professional_id = $1::uuid FOR NO KEY UPDATE`;
	const { rows: [professional] } = await transaction.query<AppointmentProfessional>(query, [professionalId]);
	if(!professional) {
		throw Object.assign(new Error("Professional not found"), { status: 404 });
	}

	return professional;

};

const lockPatient = async (transaction: TransactionClient, patientId: string) => {

	const { rows: [patient] } = await transaction.query<Pick<Appointment, "patientId">>(
		`SELECT patient_id AS "patientId" FROM public.patients WHERE patient_id = $1::uuid FOR NO KEY UPDATE`,
		[patientId],
	);
	if(!patient) {
		throw Object.assign(new Error("Patient not found"), { status: 404 });
	}

};

const validateAppointment = async (
	transaction: TransactionClient,
	clinicId: string,
	registration: AppointmentRegistration,
	{ service, professional, user }: AppointmentEligibility,
	previousAppointmentId?: string,
) => {

	const { rows: [association] } = await transaction.query(
		`SELECT 1 FROM public.professional_services WHERE professional_id = $1::uuid AND service_id = $2::uuid AND is_active`,
		[professional.professionalId, registration.serviceId],
	);
	const serviceIsAllowed = service.isActive || previousAppointmentId !== undefined;
	const isEligible = serviceIsAllowed && user.isActive && user.role === "healthcare_professional" &&
		professional.specialtyId === service.specialtyId && association !== undefined;
	if(!isEligible) {
		throw Object.assign(new Error("Service or professional is not eligible for booking"), { status: 409 });
	}

	const endAt = new Date(registration.startAt.getTime()+service.durationMinutes*60_000);
	const { rows: [clinic] } = await transaction.query<Pick<Clinic, "timeZone">>(
		`SELECT time_zone AS "timeZone" FROM public.clinics WHERE clinic_id = $1::uuid`,
		[clinicId],
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
		       AND ($5::uuid IS NULL OR appointment_id <> $5::uuid)
		       AND start_at < $4::timestamptz AND end_at > $3::timestamptz
		 ) AS conflicts`,
		[professional.professionalId, registration.patientId, registration.startAt, endAt, previousAppointmentId ?? null],
	);
	if(occupation.conflicts) {
		throw Object.assign(new Error("Appointment overlaps reserved time or a block"), { status: 409 });
	}

	return endAt;

};

const insertAppointment = async (
	transaction: TransactionClient,
	clinicId: string,
	registration: AppointmentRegistration,
	endAt: Date,
	previousAppointmentId?: string,
) => {

	const { rows: [appointment] } = await transaction.query<Pick<Appointment, "appointmentId">>(
		`INSERT INTO public.appointments (clinic_id, professional_id, patient_id, service_id, start_at, end_at, previous_appointment_id)
		 SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz, $6::timestamptz, $7::uuid
		 WHERE $5::timestamptz > clock_timestamp() AND EXTRACT(SECOND FROM $5::timestamptz AT TIME ZONE 'UTC') = 0
		 RETURNING appointment_id AS "appointmentId"`,
		[clinicId, registration.professionalId, registration.patientId, registration.serviceId, registration.startAt, endAt, previousAppointmentId ?? null],
	);
	if(!appointment) {
		throw Object.assign(new Error("Appointment start must be a future whole UTC minute"), { status: 400 });
	}

	return appointment;

};

export const createAppointment = (authentication: Authentication, registration: AppointmentRegistration) => {

	return runAuthorizedTransaction(authentication, { name: "createAppointment", professionalId: registration.professionalId }, async (transaction, actor) => {

		const isReception = actor.role === UserRole.reception;
		const service = await lockService(transaction, registration.serviceId, isReception);
		const professional = await lockProfessional(transaction, registration.professionalId, isReception);
		await lockPatient(transaction, registration.patientId);
		const endAt = await validateAppointment(transaction, actor.clinicId!, registration, { service, professional, user: actor.destinationUser! });
		const appointment = await insertAppointment(transaction, actor.clinicId!, registration, endAt);
		await incrementAvailabilityVersion(transaction, actor.clinicId!);

		return appointment;

	});

};

export const rescheduleAppointment = (authentication: Authentication, appointmentId: string, destination: AppointmentDestination) => {

	return runAuthorizedTransaction(authentication, { name: "rescheduleAppointment", appointmentId, destinationProfessionalId: destination.professionalId }, async (transaction, actor) => {

		const references = actor.originalAppointment!;
		const isReception = actor.role === UserRole.reception;
		const service = await lockService(transaction, references.serviceId, isReception);
		const professionals = new Map<string, AppointmentProfessional>();
		const professionalIds = new Set([references.professionalId, destination.professionalId.toLowerCase()]);
		for(const professionalId of [...professionalIds].sort()) {
			professionals.set(professionalId, await lockProfessional(transaction, professionalId, isReception));
		}
		await lockPatient(transaction, references.patientId);
		const { rows: [original] } = await transaction.query<Pick<Appointment, "clinicId" | "professionalId" | "patientId" | "serviceId" | "state">>(
			`SELECT clinic_id AS "clinicId", professional_id AS "professionalId", patient_id AS "patientId", service_id AS "serviceId", state
			 FROM public.appointments WHERE appointment_id = $1::uuid FOR NO KEY UPDATE`,
			[appointmentId],
		);
		if(!original) {
			throw Object.assign(new Error("Appointment not found"), { status: 404 });
		}
		const referencesMatch = original.clinicId === actor.clinicId && original.professionalId === references.professionalId &&
			original.patientId === references.patientId && original.serviceId === references.serviceId;
		if(original.state !== "reserved" || !referencesMatch) {
			throw Object.assign(new Error("Original appointment is no longer reserved or its references changed"), { status: 409 });
		}

		const professional = professionals.get(destination.professionalId.toLowerCase())!;
		const registration = { ...destination, professionalId: professional.professionalId, patientId: original.patientId, serviceId: original.serviceId };
		const endAt = await validateAppointment(transaction, actor.clinicId!, registration, { service, professional, user: actor.destinationUser! }, appointmentId);
		await transaction.query("UPDATE public.appointments SET state = 'rescheduled' WHERE appointment_id = $1::uuid", [appointmentId]);
		const appointment = await insertAppointment(transaction, actor.clinicId!, registration, endAt, appointmentId);
		await incrementAvailabilityVersion(transaction, actor.clinicId!);

		return appointment;

	});

};

export const cancelAppointment = (authentication: Authentication, appointmentId: string, cancellationReason: string) => {

	return runAuthorizedTransaction(authentication, { name: "cancelAppointment" }, async (transaction, actor) => {

		const { rows: [appointment] } = await transaction.query<Pick<Appointment, "appointmentId" | "state">>(
			`SELECT appointment_id AS "appointmentId", state FROM public.appointments WHERE appointment_id = $1::uuid FOR NO KEY UPDATE`,
			[appointmentId],
		);
		if(!appointment) {
			throw Object.assign(new Error("Appointment not found"), { status: 404 });
		}
		if(appointment.state !== "reserved") {
			throw Object.assign(new Error("Appointment is no longer reserved"), { status: 409 });
		}

		await transaction.query(
			`UPDATE public.appointments SET state = 'cancelled', cancellation_reason = $2::text, cancelled_by_user_id = $3::uuid
			 WHERE appointment_id = $1::uuid`,
			[appointment.appointmentId, cancellationReason, actor.userId],
		);
		await incrementAvailabilityVersion(transaction, actor.clinicId!);

		return { appointmentId: appointment.appointmentId };

	});

};
