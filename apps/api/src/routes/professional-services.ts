import type { RequestHandler } from "express";
import { createProfessionalService, updateProfessionalServiceActivity } from "../database/professional-services.js";
import { isUuid } from "../validation.js";

export const registerProfessionalService: RequestHandler = async (request, response) => {

	const { professionalId } = request.params;
	const body = request.body;
	const serviceId: unknown = body?.serviceId;
	const hasOtherFields = Object.keys(body ?? {}).some((field) => field !== "serviceId");
	if(!isUuid(professionalId) || !isUuid(serviceId) || hasOtherFields) {
		throw Object.assign(new Error("Invalid professional service association"), { status: 400 });
	}

	const association = await createProfessionalService(request.authentication!, { professionalId, serviceId });
	response.status(201).json(association);

};

export const editProfessionalServiceActivity: RequestHandler = async (request, response) => {

	const { professionalId, serviceId } = request.params;
	const body = request.body;
	const isActive: unknown = body?.isActive;
	const hasOtherFields = Object.keys(body ?? {}).some((field) => field !== "isActive");
	if(!isUuid(professionalId) || !isUuid(serviceId) || typeof isActive !== "boolean" || hasOtherFields) {
		throw Object.assign(new Error("Invalid professional service association activity"), { status: 400 });
	}

	const association = await updateProfessionalServiceActivity(request.authentication!, { professionalId, serviceId }, isActive);
	response.status(200).json(association);

};
