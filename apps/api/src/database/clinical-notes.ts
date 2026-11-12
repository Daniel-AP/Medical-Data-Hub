import type { Appointment, ClinicalNote } from "../generated/prisma/client.js";
import type { Authentication } from "../middleware/types.js";
import { createAuditReadRecorder, insertAuditEvent } from "./audit-events.js";
import { runAuthorizedTransaction } from "./authorization.js";
import { TransactionFailure } from "./transaction-errors.js";

type NoteAppointment = Pick<Appointment, "appointmentId" | "patientId" | "state">;
type StoredNote = Pick<ClinicalNote, "appointmentId" | "content"> & Pick<Appointment, "patientId">;

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

export const readClinicalNote = (authentication: Authentication, appointmentId: string) => {

	return runAuthorizedTransaction(authentication, { name: "readClinicalNote" }, async (transaction, actor) => {

		const { rows: [note] } = await transaction.query<StoredNote>(
			`SELECT note.appointment_id AS "appointmentId", appointment.patient_id AS "patientId", note.content
			 FROM public.clinical_notes AS note
			 JOIN public.appointments AS appointment USING (clinic_id, appointment_id)
			 WHERE note.appointment_id = $1::uuid AND note.clinic_id = $2::uuid AND appointment.professional_id = $3::uuid`,
			[appointmentId, actor.clinicId, actor.professionalId],
		);
		if(!note) {
			throw Object.assign(new Error("Clinical note not found"), { status: 404 });
		}

		const recordReads = createAuditReadRecorder(transaction, actor);
		await recordReads([{
			resource: "clinical_note",
			appointmentId: note.appointmentId,
			patientId: note.patientId,
		}]);

		return { appointmentId: note.appointmentId, content: note.content };

	});

};
