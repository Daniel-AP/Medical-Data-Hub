import type { Pool } from "pg";
import type { AuditRecord } from "../generated/prisma/client.js";
import type { Authentication } from "../middleware/types.js";
import { runAuthorizedTransaction } from "./transaction-context.js";

type AuditRecordFilters = { userId?: string; patientId?: string; from?: Date; to?: Date };
type AuditRecordMetadata = Omit<AuditRecord, "resource"> & { resource: "patient_contact" | "clinical_note" };

export function readAuditRecords(authentication: Authentication, filters: AuditRecordFilters, pool?: Pool) {
	return runAuthorizedTransaction(
		authentication,
		"readAuditRecords",
		async (client, actor) => {
			const { rows } = await client.query<AuditRecordMetadata>(
				`SELECT audit_record_id AS "auditRecordId", clinic_id AS "clinicId", user_id AS "userId",
				        patient_id AS "patientId", resource, appointment_id AS "appointmentId", action, occurred_at AS "occurredAt"
				 FROM public.audit_records
				 WHERE clinic_id = $1::uuid
				   AND ($2::uuid IS NULL OR user_id = $2)
				   AND ($3::uuid IS NULL OR patient_id = $3)
				   AND ($4::timestamptz IS NULL OR occurred_at >= $4)
				   AND ($5::timestamptz IS NULL OR occurred_at < $5)
				 ORDER BY occurred_at DESC, audit_record_id DESC`,
				[actor.clinicId, filters.userId, filters.patientId, filters.from, filters.to],
			);
			return rows;
		},
		pool,
	);
}
