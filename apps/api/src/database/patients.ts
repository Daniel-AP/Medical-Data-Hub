import type { Pool } from "pg";
import type { Patient } from "../generated/prisma/client.js";
import type { Authentication } from "../middleware/types.js";
import { insertAuditEvent } from "./audit/record-events.js";
import { runAuthorizedTransaction } from "./transactions/authorized-transaction.js";
import { TransactionFailure } from "./transactions/transaction-failure.js";

type PatientRegistration = Pick<Patient, "identification" | "name" | "email" | "phone"> & { dateOfBirth: string };

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

	}, pool).catch((error: unknown) => {

		const duplicateIdentification = error instanceof TransactionFailure && error.sqlState === "23505" &&
			error.constraint === "patients_identification_key";
		if(duplicateIdentification) {
			throw Object.assign(new Error("Patient identification is already registered"), { status: 409 });
		}
		throw error;

	});

};
