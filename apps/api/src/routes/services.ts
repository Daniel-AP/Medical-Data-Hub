import type { RequestHandler } from "express";
import { createService } from "../database/services.js";
import { isRequiredText, isUuid } from "../validation.js";

export const registerService: RequestHandler = async (request, response) => {

	const body = request.body;
	const name: unknown = body?.name;
	const durationMinutes: unknown = body?.durationMinutes;
	const specialtyId: unknown = body?.specialtyId;
	const validDuration = typeof durationMinutes === "number" && Number.isInteger(durationMinutes) &&
		durationMinutes > 0 && durationMinutes <= 2_147_483_647;
	const hasOtherFields = Object.keys(body ?? {}).some(
		(field) => field !== "name" && field !== "durationMinutes" && field !== "specialtyId",
	);
	if(!isRequiredText(name, 200) || !validDuration || !isUuid(specialtyId) || hasOtherFields) {
		throw Object.assign(new Error("Invalid service registration"), { status: 400 });
	}

	// Authentication and role middleware run before this handler
	const service = await createService(request.authentication!, { name, durationMinutes, specialtyId });
	response.status(201).json(service);

};
