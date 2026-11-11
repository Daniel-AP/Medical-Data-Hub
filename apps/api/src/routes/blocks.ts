import type { RequestHandler } from "express";
import { createProfessionalBlock, readProfessionalBlocks } from "../database/blocks.js";
import { isUuid, parseTimestamp } from "../validation.js";

export const listBlocks: RequestHandler = async (request, response) => {

	const { professionalId } = request.params;
	if(!isUuid(professionalId) || Object.keys(request.query).length !== 0) {
		throw Object.assign(new Error("Invalid professional blocks request"), { status: 400 });
	}

	const blocks = await readProfessionalBlocks(request.authentication!, professionalId);
	response.set("Cache-Control", "no-store").type("json").end(JSON.stringify({ blocks }));

};

export const registerBlock: RequestHandler = async (request, response) => {

	const { professionalId } = request.params;
	const body = request.body;
	const startAt = parseTimestamp(body?.startAt);
	const endAt = parseTimestamp(body?.endAt);
	const hasOtherFields = Object.keys(body ?? {}).some((field) => field !== "startAt" && field !== "endAt");
	if(!isUuid(professionalId) || !startAt || !endAt || hasOtherFields) {
		throw Object.assign(new Error("Invalid professional block registration"), { status: 400 });
	}

	const result = await createProfessionalBlock(request.authentication!, professionalId, { startAt, endAt });
	if("conflicts" in result) {
		response.status(409).set("Cache-Control", "no-store").json({ error: "Conflict", conflicts: result.conflicts });

		return;
	}
	response.status(201).json(result);

};
