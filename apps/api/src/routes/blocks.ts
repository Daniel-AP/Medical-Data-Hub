import type { RequestHandler } from "express";
import { readProfessionalBlocks } from "../database/blocks.js";
import { isUuid } from "../validation.js";

export const listBlocks: RequestHandler = async (request, response) => {

	const { professionalId } = request.params;
	if(!isUuid(professionalId) || Object.keys(request.query).length !== 0) {
		throw Object.assign(new Error("Invalid professional blocks request"), { status: 400 });
	}

	const blocks = await readProfessionalBlocks(request.authentication!, professionalId);
	response.set("Cache-Control", "no-store").type("json").end(JSON.stringify({ blocks }));

};
