import type { RequestHandler } from "express";
import { createService, updateService } from "../database/services.js";
import { isRequiredText, isUuid } from "../validation.js";

const registrationFields = ["name", "durationMinutes", "specialtyId"];
const editFields = [...registrationFields, "isActive"];

const isServiceDuration = (value: unknown): value is number => {
	return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2_147_483_647;
};

export const createServiceHandler: RequestHandler = async (request, response) => {

	const body = request.body;
	const name: unknown = body?.name;
	const durationMinutes: unknown = body?.durationMinutes;
	const specialtyId: unknown = body?.specialtyId;
	const hasOtherFields = Object.keys(body ?? {}).some((field) => !registrationFields.includes(field));
	if(!isRequiredText(name, 200) || !isServiceDuration(durationMinutes) || !isUuid(specialtyId) || hasOtherFields) {
		throw Object.assign(new Error("Invalid service registration"), { status: 400 });
	}

	const service = await createService(request.authentication!, { name, durationMinutes, specialtyId });
	response.status(201).json(service);

};

export const updateServiceHandler: RequestHandler = async (request, response) => {

	const { serviceId } = request.params;
	const body = request.body;
	const name: unknown = body?.name;
	const durationMinutes: unknown = body?.durationMinutes;
	const specialtyId: unknown = body?.specialtyId;
	const isActive: unknown = body?.isActive;

	const validName = name === undefined || isRequiredText(name, 200);
	const validDuration = durationMinutes === undefined || isServiceDuration(durationMinutes);
	const validSpecialty = specialtyId === undefined || isUuid(specialtyId);
	const validActivity = isActive === undefined || typeof isActive === "boolean";
	const fields = Object.keys(body ?? {});
	const validFields = fields.length > 0 && fields.every((field) => editFields.includes(field));
	const validChanges = validName && validDuration && validSpecialty && validActivity && validFields;
	if(!isUuid(serviceId) || !validChanges) {
		throw Object.assign(new Error("Invalid service changes"), { status: 400 });
	}

	const service = await updateService(request.authentication!, serviceId, { name, durationMinutes, specialtyId, isActive });
	response.status(200).json(service);

};
