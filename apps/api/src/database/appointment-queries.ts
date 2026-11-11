import type { Appointment } from "../generated/prisma/client.js";
import type { Authentication } from "../middleware/types.js";
import { runAuthorizedTransaction } from "./transactions/authorized-transaction.js";

type AppointmentMetadata = Pick<Appointment,
	"appointmentId" | "patientId" | "professionalId" | "serviceId" | "startAt" | "endAt" | "state" | "previousAppointmentId"
>;

const appointmentColumns = `appointment.appointment_id AS "appointmentId", appointment.patient_id AS "patientId",
	appointment.professional_id AS "professionalId", appointment.service_id AS "serviceId",
	appointment.start_at AS "startAt", appointment.end_at AS "endAt", appointment.state,
	appointment.previous_appointment_id AS "previousAppointmentId"`;

// Compare local dates to retain repeated midnights. Appointment timestamps have millisecond precision.
const agendaDateFilter = `(appointment.start_at AT TIME ZONE clinic.time_zone)::date <= $2::date
	AND ((appointment.end_at-interval '1 millisecond') AT TIME ZONE clinic.time_zone)::date >= $2::date
	AND ($2::date::timestamp AT TIME ZONE clinic.time_zone) < (($2::date+1)::timestamp AT TIME ZONE clinic.time_zone)`;

export const readPatientAppointmentHistory = (authentication: Authentication, patientId: string) => {

	return runAuthorizedTransaction(authentication, { name: "readPatientAppointmentHistory" }, async (client, actor) => {

		const { rows } = await client.query<AppointmentMetadata | { appointmentId: null }>(
			`SELECT ${appointmentColumns}
			 FROM public.patients AS patient
			 LEFT JOIN public.appointments AS appointment USING (clinic_id, patient_id)
			 WHERE patient.clinic_id = $1::uuid AND patient.patient_id = $2::uuid
			 ORDER BY appointment.start_at DESC, appointment.appointment_id ASC`,
			[actor.clinicId, patientId],
		);
		if(rows.length === 0) {
			throw Object.assign(new Error("Patient not found"), { status: 404 });
		}

		return rows.filter((appointment) => appointment.appointmentId !== null);

	});

};

export const readClinicAgenda = (authentication: Authentication, date: string) => {

	return runAuthorizedTransaction(authentication, { name: "readClinicAgenda" }, async (client, actor) => {

		const { rows } = await client.query<AppointmentMetadata>(
			`SELECT ${appointmentColumns}
			 FROM public.clinics AS clinic
			 JOIN public.appointments AS appointment USING (clinic_id)
			 WHERE clinic.clinic_id = $1::uuid
			   AND ${agendaDateFilter}
			 ORDER BY appointment.start_at ASC, appointment.appointment_id ASC`,
			[actor.clinicId, date],
		);

		return rows;

	});

};

export const readProfessionalAgenda = (authentication: Authentication, date: string, professionalId?: string) => {

	const name = professionalId === undefined ? "readOwnAgenda" : "readProfessionalAgenda";

	return runAuthorizedTransaction(authentication, { name }, async (client, actor) => {

		const { rows } = await client.query<AppointmentMetadata | { appointmentId: null }>(
			`SELECT ${appointmentColumns}
			 FROM public.professionals AS professional
			 JOIN public.clinics AS clinic USING (clinic_id)
			 LEFT JOIN public.appointments AS appointment
			   ON appointment.clinic_id = professional.clinic_id
			  AND appointment.professional_id = professional.professional_id
			  AND ${agendaDateFilter}
			 WHERE professional.clinic_id = $1::uuid AND professional.professional_id = $3::uuid
			 ORDER BY appointment.start_at ASC, appointment.appointment_id ASC`,
			[actor.clinicId, date, professionalId ?? actor.professionalId],
		);
		if(rows.length === 0) {
			throw Object.assign(new Error("Professional not found"), { status: 404 });
		}

		return rows.filter((appointment) => appointment.appointmentId !== null);

	});

};
