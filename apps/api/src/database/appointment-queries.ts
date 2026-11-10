import type { Appointment } from "../generated/prisma/client.js";
import type { Authentication } from "../middleware/types.js";
import { runAuthorizedTransaction } from "./transactions/authorized-transaction.js";

type AppointmentHistoryEntry = Pick<Appointment,
	"appointmentId" | "patientId" | "professionalId" | "serviceId" | "startAt" | "endAt" | "state" | "previousAppointmentId"
>;

export const readPatientAppointmentHistory = (authentication: Authentication, patientId: string) => {

	return runAuthorizedTransaction(authentication, { name: "readPatientAppointmentHistory" }, async (client, actor) => {

		const { rows } = await client.query<AppointmentHistoryEntry | { appointmentId: null }>(
			`SELECT appointment.appointment_id AS "appointmentId", appointment.patient_id AS "patientId",
			        appointment.professional_id AS "professionalId", appointment.service_id AS "serviceId",
			        appointment.start_at AS "startAt", appointment.end_at AS "endAt", appointment.state,
			        appointment.previous_appointment_id AS "previousAppointmentId"
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
