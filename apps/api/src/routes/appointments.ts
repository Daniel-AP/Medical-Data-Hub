import type { RequestHandler } from "express";
import { createAppointment, rescheduleAppointment } from "../database/appointments.js";
import { isUuid, parseTimestamp } from "../validation.js";

export const registerAppointment: RequestHandler = async (request, response) => {

	const body = request.body;
	const startAt = parseTimestamp(body?.startAt);
	const hasOtherFields = Object.keys(body ?? {}).some((field) => !["patientId", "professionalId", "serviceId", "startAt"].includes(field));
	if(!isUuid(body?.patientId) || !isUuid(body?.professionalId) || !isUuid(body?.serviceId) || !startAt || hasOtherFields) {
		throw Object.assign(new Error("Invalid appointment registration"), { status: 400 });
	}

	const appointment = await createAppointment(request.authentication!, {
		patientId: body.patientId, professionalId: body.professionalId, serviceId: body.serviceId, startAt,
	});
	response.status(201).json(appointment);

};

export const moveAppointment: RequestHandler = async (request, response) => {

	const { appointmentId } = request.params;
	const body = request.body;
	const startAt = parseTimestamp(body?.startAt);
	const hasOtherFields = Object.keys(body ?? {}).some((field) => field !== "professionalId" && field !== "startAt");
	if(!isUuid(appointmentId) || !isUuid(body?.professionalId) || !startAt || hasOtherFields) {
		throw Object.assign(new Error("Invalid appointment rescheduling"), { status: 400 });
	}

	const appointment = await rescheduleAppointment(request.authentication!, appointmentId, { professionalId: body.professionalId, startAt });
	response.status(201).json(appointment);

};
