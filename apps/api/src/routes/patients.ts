import type { RequestHandler } from "express";
import { createPatient } from "../database/patients.js";
import { isCalendarDate, isRequiredText } from "../validation.js";

const registrationFields = ["identification", "name", "dateOfBirth", "email", "phone"];

export const registerPatient: RequestHandler = async (request, response) => {

	const body = request.body;
	const identification: unknown = body?.identification;
	const name: unknown = body?.name;
	const dateOfBirth: unknown = body?.dateOfBirth;
	const email: unknown = body?.email ?? null;
	const phone: unknown = body?.phone ?? null;
	const validEmail = email === null || (isRequiredText(email, 320) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
	const validPhone = phone === null || (isRequiredText(phone, 32) && /^\+?[0-9 ()-]+$/.test(phone) && /[0-9]/.test(phone));
	const hasContact = email !== null || phone !== null;
	const hasOtherFields = Object.keys(body ?? {}).some((field) => !registrationFields.includes(field));
	const validPatient = isRequiredText(identification, 50) && isRequiredText(name, 200) && isCalendarDate(dateOfBirth);
	if(!validPatient || !validEmail || !validPhone || !hasContact || hasOtherFields) {
		throw Object.assign(new Error("Invalid patient registration"), { status: 400 });
	}

	const patient = await createPatient(request.authentication!, { identification, name, dateOfBirth, email, phone });
	response.status(201).json(patient);

};
