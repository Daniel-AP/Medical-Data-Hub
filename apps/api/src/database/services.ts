import type { Service } from "../generated/prisma/client.js";
import type { Authentication } from "../middleware/types.js";
import { incrementAvailabilityVersion } from "./availability-versions.js";
import { runAuthorizedTransaction } from "./transactions/authorized-transaction.js";
import { TransactionFailure } from "./transactions/transaction-failure.js";

type ServiceRegistration = Pick<Service, "name" | "durationMinutes" | "specialtyId">;
type ServiceDetails = Pick<Service, "serviceId" | "name" | "durationMinutes" | "specialtyId" | "isActive">;
type ServiceChanges = Partial<Omit<ServiceDetails, "serviceId">>;

const serviceColumns = `service_id AS "serviceId", name, duration_minutes AS "durationMinutes",
	specialty_id AS "specialtyId", is_active AS "isActive"`;

const throwServiceWriteError = (error: unknown): never => {

	if(error instanceof TransactionFailure) {

		if(error.sqlState === "23505" && error.constraint === "services_clinic_name_key") {
			throw Object.assign(new Error("Service name is already registered"), { status: 409 });
		}
		if(error.sqlState === "23503" && error.constraint === "services_clinic_id_specialty_id_fkey") {
			throw Object.assign(new Error("Specialty not found"), { status: 404 });
		}

	}
	throw error;

};

export const createService = (authentication: Authentication, registration: ServiceRegistration) => {

	return runAuthorizedTransaction(authentication, { name: "createService" }, async (transaction, actor) => {

		const { rows: [service] } = await transaction.query<Pick<Service, "serviceId">>(
			`INSERT INTO public.services (clinic_id, name, duration_minutes, specialty_id)
			 VALUES ($1::uuid, $2::text, $3::integer, $4::uuid)
			 RETURNING service_id AS "serviceId"`,
			[actor.clinicId, registration.name, registration.durationMinutes, registration.specialtyId],
		);

		return service;

	}).catch(throwServiceWriteError);

};

export const updateService = (authentication: Authentication, serviceId: string, changes: ServiceChanges) => {

	return runAuthorizedTransaction(authentication, { name: "updateService" }, async (transaction, actor) => {

		const { rows: [service] } = await transaction.query<ServiceDetails>(
			`SELECT ${serviceColumns}
			 FROM public.services WHERE service_id = $1::uuid
			 FOR NO KEY UPDATE`,
			[serviceId],
		);
		if(!service) {
			throw Object.assign(new Error("Service not found"), { status: 404 });
		}

		const { name, durationMinutes, isActive } = changes;
		const specialtyId = changes.specialtyId?.toLowerCase();
		const durationChanged = durationMinutes !== undefined && durationMinutes !== service.durationMinutes;
		const specialtyChanged = specialtyId !== undefined && specialtyId !== service.specialtyId;
		const updates = [
			{ column: "name", value: name, changed: name !== undefined && name !== service.name },
			{ column: "duration_minutes", value: durationMinutes, changed: durationChanged },
			{ column: "specialty_id", value: specialtyId, changed: specialtyChanged },
			{ column: "is_active", value: isActive, changed: isActive !== undefined && isActive !== service.isActive },
		].filter(({ changed }) => changed);

		if(updates.length === 0) {
			return service;
		}

		const availabilityChanged = durationChanged || specialtyChanged;
		if(availabilityChanged) {

			const { rows: [conflicts] } = await transaction.query<{ hasAppointments: boolean; hasActiveAssociations: boolean }>(
				`SELECT EXISTS(SELECT 1 FROM public.appointments WHERE service_id = $1::uuid) AS "hasAppointments",
				        $2::boolean AND EXISTS(
				            SELECT 1 FROM public.professional_services WHERE service_id = $1::uuid AND is_active
				        ) AS "hasActiveAssociations"`,
				[service.serviceId, specialtyChanged],
			);
			if(conflicts.hasAppointments || conflicts.hasActiveAssociations) {
				throw Object.assign(new Error("Service change conflicts with appointments or active associations"), { status: 409 });
			}

		}

		const assignments = updates.map(({ column }, index) => `${column} = $${index+2}`);
		const { rows: [updatedService] } = await transaction.query<ServiceDetails>(
			`UPDATE public.services SET ${assignments.join(", ")}
			 WHERE service_id = $1::uuid RETURNING ${serviceColumns}`,
			[service.serviceId, ...updates.map(({ value }) => value)],
		);
		if(availabilityChanged) {
			await incrementAvailabilityVersion(transaction, actor.clinicId!);
		}

		return updatedService;

	}).catch(throwServiceWriteError);

};
