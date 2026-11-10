import type { Specialty } from "../generated/prisma/client.js";
import type { Authentication } from "../middleware/types.js";
import { runAuthorizedTransaction } from "./transactions/authorized-transaction.js";

export const createSpecialty = (authentication: Authentication, name: Specialty["name"]) => {

	return runAuthorizedTransaction(authentication, { name: "createSpecialty" }, async (transaction, actor) => {

		const { rows: [specialty] } = await transaction.query<Pick<Specialty, "specialtyId">>(
			`INSERT INTO public.specialties (clinic_id, name)
			 VALUES ($1::uuid, $2::text)
			 ON CONFLICT ON CONSTRAINT specialties_clinic_name_key DO NOTHING
			 RETURNING specialty_id AS "specialtyId"`,
			[actor.clinicId, name],
		);
		if(!specialty) {
			throw Object.assign(new Error("Specialty name is already registered"), { status: 409 });
		}

		return specialty;

	});

};
