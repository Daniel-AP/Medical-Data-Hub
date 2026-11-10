import type { RequestHandler } from "express";
import { createClinicalNote } from "../database/clinical-notes.js";
import { isUuid } from "../validation.js";

export const registerClinicalNote: RequestHandler = async (request, response) => {

	const { appointmentId } = request.params;
	const body = request.body;
	const content: unknown = body?.content;
	const validContent = typeof content === "string" && content.trim() !== "" && !content.includes("\0");
	if(!isUuid(appointmentId) || !validContent || Object.keys(body ?? {}).length !== 1) {
		throw Object.assign(new Error("Invalid clinical note"), { status: 400 });
	}

	const note = await createClinicalNote(request.authentication!, appointmentId, content);
	response.status(201).json(note);

};
