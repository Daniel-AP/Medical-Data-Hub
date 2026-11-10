import type { RequestHandler } from "express";
import { createClinicalNote, readClinicalNote } from "../database/clinical-notes.js";
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

export const getClinicalNote: RequestHandler = async (request, response) => {

	const { appointmentId } = request.params;
	if(!isUuid(appointmentId)) {
		throw Object.assign(new Error("Invalid appointment identifier"), { status: 400 });
	}

	response.set("Cache-Control", "no-store");
	const note = await readClinicalNote(request.authentication!, appointmentId);
	// Send the audited content without an ETag or a conditional cache response.
	response.status(200).type("json").end(JSON.stringify(note));

};
