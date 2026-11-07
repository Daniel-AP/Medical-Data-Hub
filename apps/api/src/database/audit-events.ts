import type { AuditRecord, User } from "../generated/prisma/client.js";
import type { TransactionClient } from "./types.js";

type AuditActor = Pick<User, "clinicId" | "userId">;
type AuditTarget = Pick<AuditRecord, "patientId"> &
	(
		| { resource: "patient_contact" }
		| { resource: "clinical_note"; appointmentId: NonNullable<AuditRecord["appointmentId"]> }
	);

export async function insertAuditEvent(
	client: TransactionClient,
	actor: AuditActor,
	target: AuditTarget,
	action: AuditRecord["action"],
): Promise<void> {
	const appointmentId = target.resource === "clinical_note" ? target.appointmentId : null;
	await client.query(
		`INSERT INTO public.audit_records (clinic_id, user_id, patient_id, resource, appointment_id, action)
		 VALUES ($1::uuid, $2::uuid, $3::uuid, $4::public.audit_resource, $5::uuid, $6::public.audit_action)`,
		[actor.clinicId, actor.userId, target.patientId, target.resource, appointmentId, action],
	);
}

export function createAuditReadRecorder(client: TransactionClient, actor: AuditActor) {
	const recordedResources = new Set<string>();

	return async function recordReads(targets: readonly AuditTarget[]): Promise<void> {
		for (const target of targets) {
			const resourceId = target.resource === "clinical_note" ? target.appointmentId : target.patientId;
			const key = `${target.resource}:${resourceId}`;
			if (recordedResources.has(key)) {
				continue;
			}

			recordedResources.add(key);
			await insertAuditEvent(client, actor, target, "read");
		}
	};
}
