import type { Request, RequestHandler, Response } from "express";
import { readAvailability } from "../database/availability.js";
import { isCalendarDate, isUuid } from "../validation.js";

const measurementEnabled = process.env.AVAILABILITY_MEASUREMENT_ENABLED === "true";

const sendAvailability = async (request: Request, response: Response, query: Parameters<typeof readAvailability>[1]) => {

	const mode = measurementEnabled ? request.get("Availability-Mode") ?? "cached" : "cached";
	if(mode !== "direct" && mode !== "cached") {
		throw Object.assign(new Error("Invalid availability mode"), { status: 400 });
	}
	const availability = await readAvailability(request.authentication!, query, mode === "cached");
	if(measurementEnabled) {
		const { acceptedUnits, calculatedUnits } = availability;
		response.set("Availability-Cache", `mode=${mode}, accepted=${acceptedUnits}, calculated=${calculatedUnits}`);
	}
	response.set("Cache-Control", "no-store").json(availability.response);

};

export const readProfessionalAvailabilityHandler: RequestHandler = async (request, response) => {

	const { professionalId } = request.params;
	const { serviceId, date } = request.query;
	const hasExtraParameters = Object.keys(request.query).some((name) => name !== "serviceId" && name !== "date");
	if(!isUuid(professionalId) || !isUuid(serviceId) || !isCalendarDate(date) || hasExtraParameters) {
		throw Object.assign(new Error("Invalid professional availability request"), { status: 400 });
	}

	await sendAvailability(request, response, { professionalId, serviceId, date });

};

export const readServiceAvailabilityHandler: RequestHandler = async (request, response) => {

	const { serviceId } = request.params;
	const { from, to } = request.query;
	const hasExtraParameters = Object.keys(request.query).some((name) => name !== "from" && name !== "to");
	if(!isUuid(serviceId) || !isCalendarDate(from) || !isCalendarDate(to) || from > to || hasExtraParameters) {
		throw Object.assign(new Error("Invalid service availability request"), { status: 400 });
	}
	if(Date.parse(to)-Date.parse(from) >= 31*86_400_000) {
		throw Object.assign(new Error("Availability range exceeds 31 dates"), { status: 400 });
	}

	await sendAvailability(request, response, { serviceId, from, to });

};
