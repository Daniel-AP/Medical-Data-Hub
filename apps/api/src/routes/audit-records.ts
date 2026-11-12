import type { RequestHandler } from "express";
import { readAuditRecords } from "../database/audit-records.js";
import { isUuid, parseTimestamp } from "../validation.js";

const auditFilterNames = new Set(["userId", "patientId", "from", "to"]);

const invalidFilters = () => {
	return Object.assign(new Error("Invalid audit filters"), { status: 400 });
};

const parseUuid = (value: unknown) => {

	if(value === undefined) {
		return undefined;
	}
	if(!isUuid(value)) {
		throw invalidFilters();
	}

	return value;

};

export const readAuditRecordsHandler: RequestHandler = async (request, response) => {

	const query = request.query;
	if(Object.keys(query).some((name) => !auditFilterNames.has(name))) {
		throw invalidFilters();
	}

	const userId = parseUuid(query.userId);
	const patientId = parseUuid(query.patientId);
	const from = parseTimestamp(query.from);
	const to = parseTimestamp(query.to);
	if(from && to && from >= to) {
		throw invalidFilters();
	}

	const records = await readAuditRecords(request.authentication!, { userId, patientId, from, to });
	response.json({ records });

};
