import type { Clinic, User } from "../generated/prisma/client.js";
import type { Authentication } from "../middleware/types.js";
import { runAuthorizedTransaction } from "./transactions/authorized-transaction.js";
import { TransactionFailure } from "./transactions/transaction-failure.js";

type ClinicRegistration = Pick<Clinic, "name" | "timeZone"> & { administratorIdentityId: User["identityId"] };
type ClinicRegistrationResult = { clinicId: Clinic["clinicId"]; administratorUserId: User["userId"] };

export const checkClinicCreationPermission = async (authentication: Authentication) => {
	await runAuthorizedTransaction(authentication, { name: "createClinic" }, async () => {});
};

export const createClinic = async (
	authentication: Authentication,
	registration: ClinicRegistration,
	assignAdministratorRole: (markKeycloakRoleUpdateStarted: () => void) => Promise<void>,
) => {

	try {

		return await runAuthorizedTransaction(
			authentication,
			{ name: "createClinic" },
			async (client, _actor, markKeycloakRoleUpdateStarted) => {

				const { rows: [clinic] } = await client.query<ClinicRegistrationResult>(
					`SELECT clinic_id AS "clinicId", user_id AS "administratorUserId"
					 FROM public.create_clinic($1::text, $2::text, $3::text)`,
					[registration.name, registration.timeZone, registration.administratorIdentityId],
				);
				await assignAdministratorRole(markKeycloakRoleUpdateStarted);

				return clinic;

			},
		);

	} catch (error) {

		const duplicateIdentity =
			error instanceof TransactionFailure && error.sqlState === "23505" && error.constraint === "users_identity_id_key";
		if(duplicateIdentity) {
			throw Object.assign(new Error("Administrator identity is already registered"), { status: 409 });
		}

		throw error;

	}

};
