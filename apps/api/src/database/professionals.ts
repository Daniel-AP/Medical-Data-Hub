import type { Professional } from "../generated/prisma/client.js";
import type { Authentication } from "../middleware/types.js";
import { runAuthorizedTransaction } from "./transactions/authorized-transaction.js";
import { TransactionFailure } from "./transactions/transaction-failure.js";

type ProfessionalRegistration = Pick<Professional, "userId" | "specialtyId">;
type ProfessionalSpecialty = Pick<Professional, "professionalId" | "specialtyId">;

const professionalSpecialtyColumns = `professional_id AS "professionalId", specialty_id AS "specialtyId"`;

const throwProfessionalWriteError = (error: unknown): never => {

	if(error instanceof TransactionFailure) {

		if(error.sqlState === "23505" && error.constraint === "professionals_user_key") {
			throw Object.assign(new Error("User already has a professional profile"), { status: 409 });
		}
		if(error.sqlState === "23503" && error.constraint === "professionals_clinic_id_specialty_id_fkey") {
			throw Object.assign(new Error("Specialty not found"), { status: 404 });
		}

	}
	throw error;

};

export const createProfessional = (authentication: Authentication, registration: ProfessionalRegistration) => {

	return runAuthorizedTransaction(
		authentication,
		{ name: "createProfessional", targetUserId: registration.userId },
		async (transaction, actor) => {

			const user = actor.targetUser;
			if(!user) {
				throw Object.assign(new Error("User not found"), { status: 404 });
			}
			if(user.role !== "healthcare_professional") {
				throw Object.assign(new Error("User does not have the professional role"), { status: 409 });
			}

			const { rows: [professional] } = await transaction.query<Pick<Professional, "professionalId">>(
				`INSERT INTO public.professionals (clinic_id, user_id, specialty_id)
				 VALUES ($1::uuid, $2::uuid, $3::uuid)
				 RETURNING professional_id AS "professionalId"`,
				[actor.clinicId, user.userId, registration.specialtyId],
			);

			return professional;

		},
	).catch(throwProfessionalWriteError);

};

export const updateProfessionalSpecialty = (authentication: Authentication, professionalId: string, specialtyId: string) => {

	return runAuthorizedTransaction(authentication, { name: "updateProfessionalSpecialty" }, async (transaction) => {

		const { rows: [professional] } = await transaction.query<ProfessionalSpecialty>(
			`SELECT ${professionalSpecialtyColumns}
			 FROM public.professionals WHERE professional_id = $1::uuid
			 FOR NO KEY UPDATE`,
			[professionalId],
		);
		if(!professional) {
			throw Object.assign(new Error("Professional not found"), { status: 404 });
		}
		if(specialtyId.toLowerCase() === professional.specialtyId) {
			return professional;
		}

		const { rows: [activeAssociation] } = await transaction.query(
			`SELECT 1 FROM public.professional_services
			 WHERE professional_id = $1::uuid AND is_active LIMIT 1`,
			[professional.professionalId],
		);
		if(activeAssociation) {
			throw Object.assign(new Error("Professional has active service associations"), { status: 409 });
		}

		const { rows: [updatedProfessional] } = await transaction.query<ProfessionalSpecialty>(
			`UPDATE public.professionals SET specialty_id = $2::uuid
			 WHERE professional_id = $1::uuid RETURNING ${professionalSpecialtyColumns}`,
			[professional.professionalId, specialtyId],
		);

		return updatedProfessional;

	}).catch(throwProfessionalWriteError);

};
