import type { Request, RequestHandler } from "express";
import { readAppointmentCounts, readClinicAgenda, readPatientAppointmentHistory, readProfessionalAgenda } from "../database/appointment-queries.js";
import { isUuid } from "../validation.js";

const parseDate = (date: unknown) => {

	if(typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		throw Object.assign(new Error("Invalid calendar date"), { status: 400 });
	}

	const parsed = new Date(`${date}T00:00:00Z`);
	const validDate = !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date && !date.startsWith("0000");
	if(!validDate) {
		throw Object.assign(new Error("Invalid calendar date"), { status: 400 });
	}

	return date;

};

const parseAgendaDate = (query: Request["query"]) => {

	if(Object.keys(query).some((name) => name !== "date")) {
		throw Object.assign(new Error("Invalid agenda query parameters"), { status: 400 });
	}

	return parseDate(query.date);

};

export const getAppointmentCounts: RequestHandler = async (request, response) => {

	const from = parseDate(request.query.from);
	const to = parseDate(request.query.to);
	const hasExtraParameters = Object.keys(request.query).some((name) => name !== "from" && name !== "to");
	if(from > to || hasExtraParameters) {
		throw Object.assign(new Error("Invalid appointment count range or query parameters"), { status: 400 });
	}

	const counts = await readAppointmentCounts(request.authentication!, from, to);
	response.set("Cache-Control", "no-store").type("json").end(JSON.stringify({ counts }));

};

export const listPatientAppointments: RequestHandler = async (request, response) => {

	const { patientId } = request.params;
	if(!isUuid(patientId) || Object.keys(request.query).length !== 0) {
		throw Object.assign(new Error("Invalid appointment history request"), { status: 400 });
	}

	const appointments = await readPatientAppointmentHistory(request.authentication!, patientId);
	response.set("Cache-Control", "no-store").type("json").end(JSON.stringify({ appointments }));

};

export const listClinicAgenda: RequestHandler = async (request, response) => {
	const date = parseAgendaDate(request.query);
	const appointments = await readClinicAgenda(request.authentication!, date);
	response.set("Cache-Control", "no-store").type("json").end(JSON.stringify({ appointments }));
};

export const listProfessionalAgenda: RequestHandler = async (request, response) => {

	const { professionalId } = request.params;
	if(!isUuid(professionalId)) {
		throw Object.assign(new Error("Invalid professional identifier"), { status: 400 });
	}

	const date = parseAgendaDate(request.query);
	const appointments = await readProfessionalAgenda(request.authentication!, date, professionalId);
	response.set("Cache-Control", "no-store").type("json").end(JSON.stringify({ appointments }));

};

export const listOwnAgenda: RequestHandler = async (request, response) => {
	const date = parseAgendaDate(request.query);
	const appointments = await readProfessionalAgenda(request.authentication!, date);
	response.set("Cache-Control", "no-store").type("json").end(JSON.stringify({ appointments }));
};
