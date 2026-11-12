import type { Professional, ProfessionalService, Service } from "../generated/prisma/client.js";
import type { Authentication } from "../middleware/types.js";
import { incrementAvailabilityVersion } from "./availability-versions.js";
import { runAuthorizedTransaction } from "./authorization.js";
import type { TransactionClient } from "./types.js";

type ProfessionalServicePair = Pick<ProfessionalService, "professionalId" | "serviceId">;
type ProfessionalServiceActivity = Pick<ProfessionalService, "professionalId" | "serviceId" | "isActive">;

const pairColumns = `professional_id AS "professionalId", service_id AS "serviceId"`;
const activityColumns = `${pairColumns}, is_active AS "isActive"`;

const lockServiceAndProfessional = async (transaction: TransactionClient, pair: ProfessionalServicePair) => {

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

	return { specialtiesMatch: professional.specialtyId === service.specialtyId };

};

export const createProfessionalService = (authentication: Authentication, pair: ProfessionalServicePair) => {

	return runAuthorizedTransaction(authentication, { name: "createProfessionalService" }, async (transaction, actor) => {

		const { specialtiesMatch } = await lockServiceAndProfessional(transaction, pair);
		if(!specialtiesMatch) {
			throw Object.assign(new Error("Professional and service specialties do not match"), { status: 409 });
		}

		const { rows: [association] } = await transaction.query<ProfessionalServicePair>(
			`INSERT INTO public.professional_services (clinic_id, professional_id, service_id)
			 VALUES ($1::uuid, $2::uuid, $3::uuid)
			 ON CONFLICT ON CONSTRAINT professional_services_pkey DO NOTHING
			 RETURNING ${pairColumns}`,
			[actor.clinicId, pair.professionalId, pair.serviceId],
		);
		if(!association) {
			throw Object.assign(new Error("Professional service association already exists"), { status: 409 });
		}
		await incrementAvailabilityVersion(transaction, actor.clinicId!);

		return association;

	});

};

export const updateProfessionalServiceActivity = (authentication: Authentication, pair: ProfessionalServicePair, isActive: boolean) => {

	return runAuthorizedTransaction(authentication, { name: "updateProfessionalServiceActivity" }, async (transaction, actor) => {

		const { specialtiesMatch } = await lockServiceAndProfessional(transaction, pair);
		const clinicId = actor.clinicId!;
		const pairIds = [clinicId, pair.professionalId, pair.serviceId];
		const { rows: [association] } = await transaction.query<ProfessionalServiceActivity>(
			`SELECT ${activityColumns} FROM public.professional_services
			 WHERE clinic_id = $1::uuid AND professional_id = $2::uuid AND service_id = $3::uuid`,
			pairIds,
		);
		if(!association) {
			throw Object.assign(new Error("Professional service association not found"), { status: 404 });
		}
		if(association.isActive === isActive) {
			return association;
		}

		if(isActive && !specialtiesMatch) {
			throw Object.assign(new Error("Professional and service specialties do not match"), { status: 409 });
		}
		if(!isActive) {

			const { rows: [reservation] } = await transaction.query(
				`SELECT 1 FROM public.appointments
				 WHERE clinic_id = $1::uuid AND professional_id = $2::uuid AND service_id = $3::uuid
				   AND state = 'reserved' LIMIT 1`,
				pairIds,
			);
			if(reservation) {
				throw Object.assign(new Error("Professional service association has reserved appointments"), { status: 409 });
			}

		}

		const { rows: [updatedAssociation] } = await transaction.query<ProfessionalServiceActivity>(
			`UPDATE public.professional_services SET is_active = $4::boolean
			 WHERE clinic_id = $1::uuid AND professional_id = $2::uuid AND service_id = $3::uuid
			 RETURNING ${activityColumns}`,
			[...pairIds, isActive],
		);
		await incrementAvailabilityVersion(transaction, clinicId);

		return updatedAssociation;

	});

};
