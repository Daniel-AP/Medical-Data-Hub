import type { Request, RequestHandler } from "express";
import { readClinicAgenda, readPatientAppointmentHistory, readProfessionalAgenda } from "../database/appointment-queries.js";
import { isUuid } from "../validation.js";

const parseAgendaDate = (query: Request["query"]) => {

	const date = query.date;
	const hasExtraParameters = Object.keys(query).some((name) => name !== "date");
	if(typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || hasExtraParameters) {
		throw Object.assign(new Error("Invalid agenda date or query parameters"), { status: 400 });
	}

	const parsed = new Date(`${date}T00:00:00Z`);
	const validDate = !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date && !date.startsWith("0000");
	if(!validDate) {
		throw Object.assign(new Error("Invalid agenda date"), { status: 400 });
	}

	return date;

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
