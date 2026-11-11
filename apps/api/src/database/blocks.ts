import type { Professional, ProfessionalBlock } from "../generated/prisma/client.js";
import { UserRole } from "../generated/prisma/enums.js";
import type { Authentication } from "../middleware/types.js";
import type { AppointmentConflict } from "../schedules/types.js";
import { incrementAvailabilityVersion } from "./availability-versions.js";
import { runAuthorizedTransaction } from "./transactions/authorized-transaction.js";

type BlockMetadata = Pick<ProfessionalBlock, "professionalBlockId" | "startAt" | "endAt">;
type BlockRegistration = Pick<ProfessionalBlock, "startAt" | "endAt">;

export const readProfessionalBlocks = (authentication: Authentication, professionalId: string) => {

	return runAuthorizedTransaction(authentication, { name: "readProfessionalBlocks" }, async (transaction, actor) => {

		const { rows } = await transaction.query<BlockMetadata | { professionalBlockId: null }>(
			`SELECT block.professional_block_id AS "professionalBlockId", block.start_at AS "startAt", block.end_at AS "endAt"
			 FROM public.professionals AS professional
			 LEFT JOIN public.professional_blocks AS block USING (clinic_id, professional_id)
			 WHERE professional.clinic_id = $1::uuid AND professional.professional_id = $2::uuid
			 ORDER BY block.start_at, block.professional_block_id`,
			[actor.clinicId, professionalId],
		);
		if(rows.length === 0) {
			throw Object.assign(new Error("Professional not found"), { status: 404 });
		}

		return rows.filter((block) => block.professionalBlockId !== null);

	});

};

export const createProfessionalBlock = (authentication: Authentication, professionalId: string, registration: BlockRegistration) => {

	return runAuthorizedTransaction(authentication, { name: "createProfessionalBlock" }, async (transaction, actor) => {

		const isProfessional = actor.role === UserRole.healthcareProfessional;
		const lockQuery = isProfessional
			? `SELECT professional_id AS "professionalId" FROM public.lock_own_professional_for_no_key_update() WHERE professional_id = $1::uuid`
			: `SELECT professional_id AS "professionalId" FROM public.professionals WHERE professional_id = $1::uuid FOR NO KEY UPDATE`;
		const { rows: [professional] } = await transaction.query<Pick<Professional, "professionalId">>(lockQuery, [professionalId]);
		if(!professional) {
			throw Object.assign(new Error("Professional unavailable for block creation"), { status: isProfessional ? 403 : 404 });
		}
		if(registration.startAt >= registration.endAt) {
			throw Object.assign(new Error("Invalid block duration"), { status: 400 });
		}

		const { rows: conflicts } = await transaction.query<AppointmentConflict>(
			`SELECT appointment_id AS "appointmentId", patient_id AS "patientId", service_id AS "serviceId",
			        start_at AS "startAt", end_at AS "endAt"
			 FROM public.appointments WHERE professional_id = $1::uuid AND state = 'reserved'
			   AND start_at < $3::timestamptz AND end_at > $2::timestamptz
			 ORDER BY start_at, appointment_id`,
			[professional.professionalId, registration.startAt, registration.endAt],
		);
		if(conflicts.length > 0) {
			return { conflicts };
		}

		const { rows: [block] } = await transaction.query<Pick<ProfessionalBlock, "professionalBlockId">>(
			`INSERT INTO public.professional_blocks (clinic_id, professional_id, start_at, end_at)
			 VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz)
			 RETURNING professional_block_id AS "professionalBlockId"`,
			[actor.clinicId, professional.professionalId, registration.startAt, registration.endAt],
		);
		await incrementAvailabilityVersion(transaction, actor.clinicId!);

		return block;

	});

};
