import type { RequestHandler } from "express";
import { createProfessional, updateProfessionalSpecialty } from "../database/professionals.js";
import { isUuid } from "../validation.js";

export const registerProfessional: RequestHandler = async (request, response) => {

	const body = request.body;
	const userId: unknown = body?.userId;
	const specialtyId: unknown = body?.specialtyId;
	const hasOtherFields = Object.keys(body ?? {}).some((field) => field !== "userId" && field !== "specialtyId");
	if(!isUuid(userId) || !isUuid(specialtyId) || hasOtherFields) {
		throw Object.assign(new Error("Invalid professional registration"), { status: 400 });
	}

	const professional = await createProfessional(request.authentication!, { userId, specialtyId });
	response.status(201).json(professional);

};

export const editProfessionalSpecialty: RequestHandler = async (request, response) => {

	const { professionalId } = request.params;
	const body = request.body;
	const specialtyId: unknown = body?.specialtyId;
	const hasOtherFields = Object.keys(body ?? {}).some((field) => field !== "specialtyId");
	if(!isUuid(professionalId) || !isUuid(specialtyId) || hasOtherFields) {
		throw Object.assign(new Error("Invalid professional specialty change"), { status: 400 });
	}

	const professional = await updateProfessionalSpecialty(request.authentication!, professionalId, specialtyId);
	response.status(200).json(professional);

};
