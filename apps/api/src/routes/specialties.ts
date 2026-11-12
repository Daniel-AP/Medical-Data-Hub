import type { RequestHandler } from "express";
import { createSpecialty } from "../database/specialties.js";
import { isRequiredText } from "../validation.js";

export const createSpecialtyHandler: RequestHandler = async (request, response) => {

	const body = request.body;
	const name: unknown = body?.name;
	const hasOtherFields = Object.keys(body ?? {}).some((field) => field !== "name");
	if(!isRequiredText(name, 100) || hasOtherFields) {
		throw Object.assign(new Error("Invalid specialty registration"), { status: 400 });
	}

	const specialty = await createSpecialty(request.authentication!, name);
	response.status(201).json(specialty);

};
