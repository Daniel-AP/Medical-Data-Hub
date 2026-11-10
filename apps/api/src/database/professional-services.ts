import type { Professional, ProfessionalService, Service } from "../generated/prisma/client.js";
import type { Authentication } from "../middleware/types.js";
import { incrementAvailabilityVersion } from "./availability-versions.js";
import { runAuthorizedTransaction } from "./transactions/authorized-transaction.js";

type ProfessionalServicePair = Pick<ProfessionalService, "professionalId" | "serviceId">;

export const createProfessionalService = (authentication: Authentication, pair: ProfessionalServicePair) => {

	return runAuthorizedTransaction(authentication, { name: "createProfessionalService" }, async (transaction, actor) => {

		const { rows: [service] } = await transaction.query<Pick<Service, "specialtyId">>(
			`SELECT specialty_id AS "specialtyId" FROM public.services
			 WHERE service_id = $1::uuid FOR SHARE`,
			[pair.serviceId],
		);
		if(!service) {
			throw Object.assign(new Error("Service not found"), { status: 404 });
		}

		const { rows: [professional] } = await transaction.query<Pick<Professional, "specialtyId">>(
			`SELECT specialty_id AS "specialtyId" FROM public.professionals
			 WHERE professional_id = $1::uuid FOR NO KEY UPDATE`,
			[pair.professionalId],
		);
		if(!professional) {
			throw Object.assign(new Error("Professional not found"), { status: 404 });
		}
		if(professional.specialtyId !== service.specialtyId) {
			throw Object.assign(new Error("Professional and service specialties do not match"), { status: 409 });
		}

		const { rows: [association] } = await transaction.query<ProfessionalServicePair>(
			`INSERT INTO public.professional_services (clinic_id, professional_id, service_id)
			 VALUES ($1::uuid, $2::uuid, $3::uuid)
			 ON CONFLICT ON CONSTRAINT professional_services_pkey DO NOTHING
			 RETURNING professional_id AS "professionalId", service_id AS "serviceId"`,
			[actor.clinicId, pair.professionalId, pair.serviceId],
		);
		if(!association) {
			throw Object.assign(new Error("Professional service association already exists"), { status: 409 });
		}
		await incrementAvailabilityVersion(transaction, actor.clinicId!);

		return association;

	});

};
