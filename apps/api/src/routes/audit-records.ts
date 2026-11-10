import type { RequestHandler } from "express";
import { readAuditRecords } from "../database/audit-records.js";

const auditFilterNames = new Set(["userId", "patientId", "from", "to"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const timestampPattern = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}(?::?\d{2})?)$/;

const invalidFilters = () => {
	return Object.assign(new Error("Invalid audit filters"), { status: 400 });
};

const parseUuid = (value: unknown) => {

	if(value === undefined) {
		return undefined;
	}
	if(typeof value !== "string" || !uuidPattern.test(value)) {
		throw invalidFilters();
	}

	return value;

};

const parseTimestamp = (value: unknown) => {

	if(value === undefined) {
		return undefined;
	}
	const match = typeof value === "string" ? timestampPattern.exec(value) : null;
	if(!match) {
		throw invalidFilters();
	}

	const [, minute, second = "00", fraction = "", offset] = match;
	const local = `${minute}:${second}.${fraction.padEnd(3, "0")}`;
	const localAsUtc = new Date(`${local}Z`);
	if(Number.isNaN(localAsUtc.getTime()) || localAsUtc.toISOString() !== `${local}Z`) {
		throw invalidFilters();
	}

	const instant = new Date(`${local}${offset.length === 3 ? `${offset}:00` : offset}`);
	if(Number.isNaN(instant.getTime())) {
		throw invalidFilters();
	}

	return instant;

};

export const listAuditRecords: RequestHandler = async (request, response) => {

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

	// Authentication and role middleware run before this handler
	const records = await readAuditRecords(request.authentication!, { userId, patientId, from, to });
	response.json({ records });

};
