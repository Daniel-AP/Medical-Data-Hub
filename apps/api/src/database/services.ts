import type { Service } from "../generated/prisma/client.js";
import type { Authentication } from "../middleware/types.js";
import { runAuthorizedTransaction } from "./transactions/authorized-transaction.js";
import { TransactionFailure } from "./transactions/transaction-failure.js";

type ServiceRegistration = Pick<Service, "name" | "durationMinutes" | "specialtyId">;

export const createService = async (authentication: Authentication, registration: ServiceRegistration) => {

	try {

		return await runAuthorizedTransaction(authentication, { name: "createService" }, async (transaction, actor) => {

			const { rows: [service] } = await transaction.query<Pick<Service, "serviceId">>(
				`INSERT INTO public.services (clinic_id, name, duration_minutes, specialty_id)
				 VALUES ($1::uuid, $2::text, $3::integer, $4::uuid)
				 ON CONFLICT ON CONSTRAINT services_clinic_name_key DO NOTHING
				 RETURNING service_id AS "serviceId"`,
				[actor.clinicId, registration.name, registration.durationMinutes, registration.specialtyId],
			);
			if(!service) {
				throw Object.assign(new Error("Service name is already registered"), { status: 409 });
			}

			return service;

		});

	} catch (error) {

		const unavailableSpecialty = error instanceof TransactionFailure &&
			error.sqlState === "23503" && error.constraint === "services_clinic_id_specialty_id_fkey";
		if(unavailableSpecialty) {
			throw Object.assign(new Error("Specialty not found"), { status: 404 });
		}

		throw error;

	}

};
