import type { User } from "../generated/prisma/client.js";
import type { Authentication } from "../middleware/types.js";
import { runAuthorizedTransaction } from "./transactions/authorized-transaction.js";
import { TransactionFailure } from "./transactions/transaction-failure.js";

type UserRegistration = Pick<User, "identityId"> & { role: string };

export const checkUserCreationPermission = async (authentication: Authentication) => {
	await runAuthorizedTransaction(authentication, { name: "createUser" }, async () => {});
};

export const createUser = async (
	authentication: Authentication,
	registration: UserRegistration,
	assignUserRole: (markKeycloakRoleUpdateStarted: () => void) => Promise<void>,
) => {

	try {

		return await runAuthorizedTransaction(
			authentication,
			{ name: "createUser" },
			async (client, actor, markKeycloakRoleUpdateStarted) => {

				const { rows: [user] } = await client.query<Pick<User, "userId">>(
					`INSERT INTO public.users (identity_id, clinic_id, role)
					 VALUES ($1::text, $2::uuid, $3::public.user_role)
					 RETURNING user_id AS "userId"`,
					[registration.identityId, actor.clinicId, registration.role],
				);
				await assignUserRole(markKeycloakRoleUpdateStarted);

				return user;

			},
		);

	} catch (error) {

		const duplicateIdentity = error instanceof TransactionFailure &&
			error.sqlState === "23505" && error.constraint === "users_identity_id_key";
		if(duplicateIdentity) {
			throw Object.assign(new Error("User identity is already registered"), { status: 409 });
		}

		throw error;

	}

};
