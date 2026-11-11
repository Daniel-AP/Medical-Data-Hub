import type { ProfessionalBlock } from "../generated/prisma/client.js";
import type { Authentication } from "../middleware/types.js";
import { runAuthorizedTransaction } from "./transactions/authorized-transaction.js";

type BlockMetadata = Pick<ProfessionalBlock, "professionalBlockId" | "startAt" | "endAt">;

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
