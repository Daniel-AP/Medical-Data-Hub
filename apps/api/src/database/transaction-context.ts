import type { Pool } from "pg";
import type { Professional, User } from "../generated/prisma/client.js";
import { UserRole } from "../generated/prisma/enums.js";
import type { Authentication } from "../middleware/types.js";
import { runTransaction } from "./transaction.js";
import type { TransactionClient } from "./types.js";

const operations = {
	readAuditRecords: {
		role: UserRole.clinicAdministrator,
		databaseRole: "clinic_administrator",
		selectRole: "SET LOCAL ROLE clinic_administrator",
		requiresProfessional: false,
	},
	createClinic: {
		role: UserRole.platformAdministrator,
		databaseRole: "platform_administrator",
		selectRole: "SET LOCAL ROLE platform_administrator",
		requiresProfessional: false,
	},
	replaceOwnWeeklySchedule: {
		role: UserRole.healthcareProfessional,
		databaseRole: "healthcare_professional",
		selectRole: "SET LOCAL ROLE healthcare_professional",
		requiresProfessional: true,
	},
};

type Identity = Pick<User, "userId" | "clinicId">;
type ProfessionalAssociation = Pick<Professional, "professionalId">;
type ActorContext = Pick<User, "userId" | "clinicId" | "role"> & Partial<ProfessionalAssociation>;
type LockedUser = Identity & Pick<User, "isActive"> & { role: string };

function forbidden() {
	return Object.assign(new Error("Operation forbidden"), { status: 403 });
}

export async function runAuthorizedTransaction<T>(
	authentication: Authentication,
	operation: keyof typeof operations,
	callback: (client: TransactionClient, actor: ActorContext) => Promise<T>,
	pool?: Pool,
): Promise<T> {
	const policy = operations[operation];

	return runTransaction(
		"readCommitted",
		async (client) => {
			const identityResult = await client.query<Identity>(
				`SELECT user_id AS "userId", clinic_id AS "clinicId" FROM public.resolve_identity($1::text)`,
				[authentication.identityId],
			);
			const [identity] = identityResult.rows;
			if (!identity) {
				throw forbidden();
			}

			const actorResult = await client.query<LockedUser>(
				`SELECT user_id AS "userId", clinic_id AS "clinicId", role, is_active AS "isActive"
				 FROM public.lock_user_for_share($1::uuid, $1::uuid)`,
				[identity.userId],
			);
			const [actor] = actorResult.rows;
			const authorized =
				actor?.isActive &&
				actor.userId === identity.userId &&
				actor.clinicId === identity.clinicId &&
				actor.role === policy.databaseRole &&
				authentication.roles.includes(policy.role);
			if (!authorized) {
				throw forbidden();
			}

			const context: ActorContext = { userId: actor.userId, clinicId: actor.clinicId, role: policy.role };
			if (policy.requiresProfessional) {
				const { rows } = await client.query<ProfessionalAssociation>(
					`SELECT professional_id AS "professionalId" FROM public.resolve_actor_professional($1::uuid)`,
					[actor.userId],
				);
				const [professional] = rows;
				if (!professional) {
					throw forbidden();
				}
				context.professionalId = professional.professionalId;
			}

			await client.query(
				`SELECT pg_catalog.set_config('app.user_id', $1, true),
				        pg_catalog.set_config('app.clinic_id', $2, true)`,
				[actor.userId, actor.clinicId ?? ""],
			);
			await client.query(policy.selectRole);

			return callback(client, context);
		},
		pool,
	);
}
