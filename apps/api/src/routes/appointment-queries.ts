import type { RequestHandler } from "express";
import { readPatientAppointmentHistory } from "../database/appointment-queries.js";
import { isUuid } from "../validation.js";

export const listPatientAppointments: RequestHandler = async (request, response) => {

	const { patientId } = request.params;
	if(!isUuid(patientId) || Object.keys(request.query).length !== 0) {
		throw Object.assign(new Error("Invalid appointment history request"), { status: 400 });
	}

	const appointments = await readPatientAppointmentHistory(request.authentication!, patientId);
	response.set("Cache-Control", "no-store").type("json").end(JSON.stringify({ appointments }));

};
