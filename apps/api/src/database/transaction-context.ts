import type { Pool } from "pg";
import type { User } from "../generated/prisma/client.js";
import { UserRole } from "../generated/prisma/enums.js";
import type { Authentication } from "../middleware/types.js";
import { runTransaction } from "./transaction.js";
import type { TransactionClient } from "./types.js";

const operations = {
	readAuditRecords: {
		role: UserRole.clinicAdministrator,
		databaseRole: "clinic_administrator",
		selectRole: "SET LOCAL ROLE clinic_administrator",
	},
	createClinic: {
		role: UserRole.platformAdministrator,
		databaseRole: "platform_administrator",
		selectRole: "SET LOCAL ROLE platform_administrator",
	},
};

type Identity = Pick<User, "userId" | "clinicId">;
type ActorContext = Pick<User, "userId" | "clinicId" | "role">;
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

			await client.query(
				`SELECT pg_catalog.set_config('app.user_id', $1, true),
				        pg_catalog.set_config('app.clinic_id', $2, true)`,
				[actor.userId, actor.clinicId ?? ""],
			);
			await client.query(policy.selectRole);

			return callback(client, { userId: actor.userId, clinicId: actor.clinicId, role: policy.role });
		},
		pool,
	);
}
