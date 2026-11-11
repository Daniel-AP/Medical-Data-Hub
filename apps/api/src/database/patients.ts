import type { Pool } from "pg";
import type { Patient } from "../generated/prisma/client.js";
import type { Authentication } from "../middleware/types.js";
import { isCalendarDate, isEmail, isPhone, isRequiredText } from "../validation.js";
import { createAuditReadRecorder, insertAuditEvent } from "./audit/record-events.js";
import { runAuthorizedTransaction } from "./transactions/authorized-transaction.js";
import { TransactionFailure } from "./transactions/transaction-failure.js";

type PatientRegistration = Pick<Patient, "identification" | "name" | "email" | "phone"> & { dateOfBirth: string };
type PatientChanges = Partial<PatientRegistration>;
type StoredPatient = PatientRegistration & Pick<Patient, "patientId">;

const throwPatientWriteError = (error: unknown): never => {

	const duplicateIdentification = error instanceof TransactionFailure && error.sqlState === "23505" &&
		error.constraint === "patients_identification_key";
	if(duplicateIdentification) {
		throw Object.assign(new Error("Patient identification is already registered"), { status: 409 });
	}
	throw error;

};

export const createPatient = (authentication: Authentication, registration: PatientRegistration, pool?: Pool) => {

	return runAuthorizedTransaction(authentication, { name: "createPatient" }, async (transaction, actor) => {

		const { rows: [patient] } = await transaction.query<Pick<Patient, "patientId">>(
			`INSERT INTO public.patients (clinic_id, identification, name, date_of_birth, email, phone)
			 SELECT clinic_id, $2::text, $3::text, $4::date, $5::text, $6::text
			 FROM public.clinics
			 WHERE clinic_id = $1::uuid AND $4::date <= (clock_timestamp() AT TIME ZONE time_zone)::date
			 RETURNING patient_id AS "patientId"`,
			[actor.clinicId, registration.identification, registration.name, registration.dateOfBirth, registration.email, registration.phone],
		);
		if(!patient) {
			throw Object.assign(new Error("Date of birth is in the future"), { status: 400 });
		}
		await insertAuditEvent(transaction, actor, { resource: "patient_contact", patientId: patient.patientId }, "write");

		return { patientId: patient.patientId, created: true };

	}, pool).catch(throwPatientWriteError);

};

export const updatePatient = (authentication: Authentication, patientId: string, changes: PatientChanges, pool?: Pool) => {

	return runAuthorizedTransaction(authentication, { name: "updatePatient" }, async (transaction, actor) => {

		const lock = changes.identification === undefined ? "FOR NO KEY UPDATE" : "FOR UPDATE";
		const { rows: [patient] } = await transaction.query<StoredPatient>(
			`SELECT patient_id AS "patientId", identification, name, date_of_birth::text AS "dateOfBirth", email, phone
			 FROM public.patients WHERE patient_id = $1::uuid AND clinic_id = $2::uuid ${lock}`,
			[patientId, actor.clinicId],
		);
		if(!patient) {
			throw Object.assign(new Error("Patient not found"), { status: 404 });
		}
		const recordReads = createAuditReadRecorder(transaction, actor);
		await recordReads([{ resource: "patient_contact", patientId: patient.patientId }]);

		const updated = {
			identification: changes.identification ?? patient.identification,
			name: changes.name ?? patient.name,
			dateOfBirth: changes.dateOfBirth ?? patient.dateOfBirth,
			email: changes.email === undefined ? patient.email : changes.email,
			phone: changes.phone === undefined ? patient.phone : changes.phone,
		};
		const { rows: [clinic] } = await transaction.query<{ today: string }>(
			`SELECT (clock_timestamp() AT TIME ZONE time_zone)::date::text AS today
			 FROM public.clinics WHERE clinic_id = $1::uuid`,
			[actor.clinicId],
		);
		const validPatient = isRequiredText(updated.identification, 50) && isRequiredText(updated.name, 200) &&
			isCalendarDate(updated.dateOfBirth) && updated.dateOfBirth <= clinic.today;
		const validContact = (updated.email === null || isEmail(updated.email)) && (updated.phone === null || isPhone(updated.phone)) &&
			(updated.email !== null || updated.phone !== null);
		if(!validPatient || !validContact) {
			throw Object.assign(new Error("Invalid resulting patient record"), { status: 400 });
		}

		const updates = [
			{ column: "identification", value: changes.identification },
			{ column: "name", value: changes.name },
			{ column: "date_of_birth", value: changes.dateOfBirth },
			{ column: "email", value: changes.email },
			{ column: "phone", value: changes.phone },
		].filter(({ value }) => value !== undefined);
		const assignments = updates.map(({ column }, index) => `${column} = $${index+2}`);
		await transaction.query(
			`UPDATE public.patients SET ${assignments.join(", ")} WHERE patient_id = $1::uuid`,
			[patient.patientId, ...updates.map(({ value }) => value)],
		);
		if(changes.email !== undefined || changes.phone !== undefined) {
			await insertAuditEvent(transaction, actor, { resource: "patient_contact", patientId: patient.patientId }, "write");
		}

		return { patientId: patient.patientId, updated: true };

	}, pool).catch(throwPatientWriteError);

};
