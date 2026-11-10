import type { Appointment } from "../generated/prisma/client.js";
import type { Authentication } from "../middleware/types.js";
import { insertAuditEvent } from "./audit/record-events.js";
import { runAuthorizedTransaction } from "./transactions/authorized-transaction.js";
import { TransactionFailure } from "./transactions/transaction-failure.js";

type NoteAppointment = Pick<Appointment, "appointmentId" | "patientId" | "state">;

export const createClinicalNote = (authentication: Authentication, appointmentId: string, content: string) => {

	return runAuthorizedTransaction(authentication, { name: "createClinicalNote" }, async (transaction, actor) => {

		const { rows: [appointment] } = await transaction.query<NoteAppointment>(
			`SELECT appointment_id AS "appointmentId", patient_id AS "patientId", state
			 FROM public.appointments
			 WHERE appointment_id = $1::uuid AND clinic_id = $2::uuid AND professional_id = $3::uuid
			 FOR SHARE`,
			[appointmentId, actor.clinicId, actor.professionalId],
		);
		if(!appointment) {
			throw Object.assign(new Error("Appointment not found"), { status: 404 });
		}
		if(appointment.state !== "attended") {
			throw Object.assign(new Error("Appointment has not been attended"), { status: 409 });
		}

		await transaction.query(
			`INSERT INTO public.clinical_notes (appointment_id, clinic_id, content)
			 VALUES ($1::uuid, $2::uuid, $3::text)`,
			[appointment.appointmentId, actor.clinicId, content],
		);
		await insertAuditEvent(transaction, actor, {
			resource: "clinical_note",
			appointmentId: appointment.appointmentId,
			patientId: appointment.patientId,
		}, "write");

		return { appointmentId: appointment.appointmentId, created: true };

	}).catch((error: unknown) => {

		const duplicateNote = error instanceof TransactionFailure && error.sqlState === "23505" &&
			(error.constraint === "clinical_notes_pkey" || error.constraint === "clinical_notes_clinic_appointment_key");
		if(duplicateNote) {
			throw Object.assign(new Error("Clinical note already exists"), { status: 409 });
		}
		throw error;

	});

};
