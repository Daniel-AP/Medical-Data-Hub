import type { RequestHandler } from "express";
import { createPatient, readPatient, updatePatient } from "../database/patients.js";
import { isCalendarDate, isEmail, isPhone, isRequiredText, isUuid } from "../validation.js";

const patientFields = ["identification", "name", "dateOfBirth", "email", "phone"];

export const createPatientHandler: RequestHandler = async (request, response) => {

	const body = request.body;
	const identification: unknown = body?.identification;
	const name: unknown = body?.name;
	const dateOfBirth: unknown = body?.dateOfBirth;
	const email: unknown = body?.email ?? null;
	const phone: unknown = body?.phone ?? null;
	const validEmail = email === null || isEmail(email);
	const validPhone = phone === null || isPhone(phone);
	const hasContact = email !== null || phone !== null;
	const hasOtherFields = Object.keys(body ?? {}).some((field) => !patientFields.includes(field));
	const validPatient = isRequiredText(identification, 50) && isRequiredText(name, 200) && isCalendarDate(dateOfBirth);
	if(!validPatient || !validEmail || !validPhone || !hasContact || hasOtherFields) {
		throw Object.assign(new Error("Invalid patient registration"), { status: 400 });
	}

	const patient = await createPatient(request.authentication!, { identification, name, dateOfBirth, email, phone });
	response.status(201).json(patient);

};

export const updatePatientHandler: RequestHandler = async (request, response) => {

	const { patientId } = request.params;
	const body = request.body;
	const identification: unknown = body?.identification;
	const name: unknown = body?.name;
	const dateOfBirth: unknown = body?.dateOfBirth;
	const email: unknown = body?.email;
	const phone: unknown = body?.phone;
	const validIdentification = identification === undefined || isRequiredText(identification, 50);
	const validName = name === undefined || isRequiredText(name, 200);
	const validBirthDate = dateOfBirth === undefined || isCalendarDate(dateOfBirth);
	const validEmail = email === undefined || email === null || isEmail(email);
	const validPhone = phone === undefined || phone === null || isPhone(phone);
	const fields = Object.keys(body ?? {});
	const validFields = fields.length > 0 && fields.every((field) => patientFields.includes(field));
	const validChanges = validIdentification && validName && validBirthDate && validEmail && validPhone && validFields;
	if(!isUuid(patientId) || !validChanges) {
		throw Object.assign(new Error("Invalid patient changes"), { status: 400 });
	}

	const patient = await updatePatient(request.authentication!, patientId, { identification, name, dateOfBirth, email, phone });
	response.status(200).json(patient);

};

export const readPatientHandler: RequestHandler = async (request, response) => {

	const { patientId } = request.params;
	if(!isUuid(patientId)) {
		throw Object.assign(new Error("Invalid patient identifier"), { status: 400 });
	}

	response.set("Cache-Control", "no-store");
	const patient = await readPatient(request.authentication!, patientId);
	response.status(200).type("json").end(JSON.stringify(patient));

};
