import type { Appointment, AuditRecord, User } from "../../generated/prisma/client.js";
import type { TransactionClient } from "../transactions/types.js";

type AuditActor = Pick<User, "clinicId" | "userId">;
type PatientContactTarget = Pick<AuditRecord, "patientId"> & { resource: "patient_contact" };
type ClinicalNoteTarget = Pick<Appointment, "patientId" | "appointmentId"> & { resource: "clinical_note" };
type AuditTarget = PatientContactTarget | ClinicalNoteTarget;

export const insertAuditEvent = async (
	client: TransactionClient,
	actor: AuditActor,
	target: AuditTarget,
	action: AuditRecord["action"],
) => {

	const appointmentId = target.resource === "clinical_note" ? target.appointmentId : null;

	await client.query(
		`INSERT INTO public.audit_records (clinic_id, user_id, patient_id, resource, appointment_id, action)
		 VALUES ($1::uuid, $2::uuid, $3::uuid, $4::public.audit_resource, $5::uuid, $6::public.audit_action)`,
		[actor.clinicId, actor.userId, target.patientId, target.resource, appointmentId, action],
	);

};

export const createAuditReadRecorder = (client: TransactionClient, actor: AuditActor) => {

	const recordedReadKeys = new Set<string>();

	const recordReads = async (targets: readonly AuditTarget[]) => {

		for(const target of targets) {

			const resourceId = target.resource === "clinical_note" ? target.appointmentId : target.patientId;
			const readKey = `${target.resource}:${resourceId}`;

			if(recordedReadKeys.has(readKey)) {
				continue;
			}

			recordedReadKeys.add(readKey);
			await insertAuditEvent(client, actor, target, "read");

		}

	};

	return recordReads;

};
