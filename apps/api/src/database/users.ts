import type { ClinicUserRole } from "../clients/keycloak/roles.js";
import type { User } from "../generated/prisma/client.js";
import type { Authentication } from "../middleware/types.js";
import { incrementAvailabilityVersion } from "./availability-versions.js";
import { runAuthorizedTransaction } from "./transactions/authorized-transaction.js";
import { TransactionFailure } from "./transactions/transaction-failure.js";

type UserRegistration = Pick<User, "identityId"> & { role: ClinicUserRole };
type UserPermissionChanges = { role?: ClinicUserRole; isActive?: boolean };
type UserPermissions = Pick<User, "userId" | "isActive"> & { role: string };

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

export const updateUserPermissions = (
	authentication: Authentication,
	userId: string,
	changes: UserPermissionChanges,
	assignUserRole: (identityId: User["identityId"], role: ClinicUserRole, markKeycloakRoleUpdateStarted: () => void) => Promise<void>,
) => {

	return runAuthorizedTransaction(
		authentication,
		{ name: "updateUserPermissions", targetUserId: userId },
		async (client, actor, markKeycloakRoleUpdateStarted) => {

			const target = actor.targetUser!;
			const { role, isActive } = changes;
			const roleChanged = role !== undefined && role !== target.role;
			const activityChanged = isActive !== undefined && isActive !== target.isActive;
			if(!roleChanged && !activityChanged) {
				return { userId: target.userId, role: target.role, isActive: target.isActive };
			}

			const assignments: string[] = [];
			const values: (string | boolean)[] = [target.userId];
			if(roleChanged) {
				values.push(role);
				assignments.push(`role = $${values.length}::public.user_role`);
			}
			if(activityChanged) {
				values.push(isActive);
				assignments.push(`is_active = $${values.length}::boolean`);
			}

			const { rows: [updatedUser] } = await client.query<UserPermissions & Pick<User, "identityId">>(
				`UPDATE public.users
				 SET ${assignments.join(", ")}
				 WHERE user_id = $1::uuid
				 RETURNING user_id AS "userId", identity_id AS "identityId", role, is_active AS "isActive"`,
				values,
			);

			const { rows: [professional] } = await client.query(
				"SELECT 1 FROM public.professionals WHERE clinic_id = $1::uuid AND user_id = $2::uuid",
				[actor.clinicId, target.userId],
			);
			if(professional) {
				await incrementAvailabilityVersion(client, actor.clinicId!);
			}

			const { identityId, ...permissions } = updatedUser;
			if(roleChanged) {
				await assignUserRole(identityId, role, markKeycloakRoleUpdateStarted);
			}

			return permissions;

		},
	);

};
