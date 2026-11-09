import type { Pool } from "pg";
import type { Appointment, Professional, User } from "../generated/prisma/client.js";
import { UserRole } from "../generated/prisma/enums.js";
import type { Authentication } from "../middleware/types.js";
import { runTransaction } from "./transaction.js";
import type { TransactionClient } from "./types.js";

const profiles = {
	[UserRole.clinicAdministrator]: {
		databaseRole: "clinic_administrator",
		selectRole: "SET LOCAL ROLE clinic_administrator",
	},
	[UserRole.platformAdministrator]: {
		databaseRole: "platform_administrator",
		selectRole: "SET LOCAL ROLE platform_administrator",
	},
	[UserRole.healthcareProfessional]: {
		databaseRole: "healthcare_professional",
		selectRole: "SET LOCAL ROLE healthcare_professional",
	},
	[UserRole.reception]: { databaseRole: "reception", selectRole: "SET LOCAL ROLE reception" },
};

const clinicAdministratorPolicy = {
	roles: [UserRole.clinicAdministrator],
	requiresProfessional: false,
	isolation: "readCommitted",
} as const;
const operations = {
	readAuditRecords: clinicAdministratorPolicy,
	updateUserPermissions: clinicAdministratorPolicy,
	createClinic: { roles: [UserRole.platformAdministrator], requiresProfessional: false, isolation: "readCommitted" },
	replaceOwnWeeklySchedule: {
		roles: [UserRole.healthcareProfessional],
		requiresProfessional: true,
		isolation: "readCommitted",
	},
	rescheduleAppointment: {
		roles: [UserRole.clinicAdministrator, UserRole.reception],
		requiresProfessional: false,
		isolation: "readCommitted",
	},
	readDefinitiveAvailability: {
		roles: [UserRole.clinicAdministrator, UserRole.reception, UserRole.healthcareProfessional],
		requiresProfessional: false,
		isolation: "repeatableRead",
	},
} as const;

type Identity = Pick<User, "userId" | "clinicId">;
type ProfessionalAssociation = Pick<Professional, "professionalId">;
type LockedUser = Identity & Pick<User, "isActive"> & { role: string };
type AppointmentReferences = Pick<Appointment, "professionalId" | "patientId" | "serviceId">;
type ActorContext = Pick<User, "userId" | "clinicId" | "role"> &
	Partial<ProfessionalAssociation> & {
		targetUser?: LockedUser;
		originalAppointment?: AppointmentReferences;
		destinationUser?: LockedUser;
	};
type RescheduleOperation = { name: "rescheduleAppointment"; appointmentId: string; destinationProfessionalId: string };
type TransactionOperation =
	| Exclude<keyof typeof operations, "updateUserPermissions" | "rescheduleAppointment">
	| { name: "updateUserPermissions"; targetUserId: string }
	| RescheduleOperation;

const lockUserForShare = `SELECT user_id AS "userId", clinic_id AS "clinicId", role, is_active AS "isActive"
	FROM public.lock_user_for_share($1::uuid, $2::uuid)`;
const lockUserForNoKeyUpdate = `SELECT user_id AS "userId", clinic_id AS "clinicId", role, is_active AS "isActive"
	FROM public.lock_user_for_no_key_update($1::uuid, $2::uuid)`;

const forbidden = () => {
	return Object.assign(new Error("Operation forbidden"), { status: 403 });
};

const resolveReschedulingMetadata = async (
	client: TransactionClient,
	actorUserId: string,
	operation: RescheduleOperation,
) => {
	const appointmentResult = await client.query<AppointmentReferences>(
		`SELECT professional_id AS "professionalId", patient_id AS "patientId", service_id AS "serviceId"
		 FROM public.resolve_appointment_references($1::uuid, $2::uuid)`,
		[actorUserId, operation.appointmentId],
	);
	const [originalAppointment] = appointmentResult.rows;
	if (!originalAppointment) {
		throw forbidden();
	}

	const destinationResult = await client.query<Pick<User, "userId">>(
		`SELECT user_id AS "userId" FROM public.resolve_professional_user($1::uuid, $2::uuid)`,
		[actorUserId, operation.destinationProfessionalId],
	);
	const [destination] = destinationResult.rows;
	if (!destination) {
		throw forbidden();
	}

	return { originalAppointment, destinationUserId: destination.userId };
};

export const runAuthorizedTransaction = async <T>(
	authentication: Authentication,
	operation: TransactionOperation,
	callback: (client: TransactionClient, actor: ActorContext, markProviderMutationSent: () => void) => Promise<T>,
	pool?: Pool,
): Promise<T> => {
	const request = typeof operation === "string" ? { name: operation } : operation;
	const targetUserId = request.name === "updateUserPermissions" ? request.targetUserId.toLowerCase() : undefined;
	const policy = operations[request.name];

	return runTransaction(
		policy.isolation,
		async (client, markProviderMutationSent) => {
			const identityResult = await client.query<Identity>(
				`SELECT user_id AS "userId", clinic_id AS "clinicId" FROM public.resolve_identity($1::text)`,
				[authentication.identityId],
			);
			const [identity] = identityResult.rows;
			if (!identity) {
				throw forbidden();
			}

			const rescheduling =
				request.name === "rescheduleAppointment"
					? await resolveReschedulingMetadata(client, identity.userId, request)
					: undefined;
			const userIds = new Set([identity.userId]);
			if (targetUserId !== undefined) {
				userIds.add(targetUserId);
			}
			if (rescheduling) {
				userIds.add(rescheduling.destinationUserId);
			}

			const lockedUsers = new Map<string, LockedUser>();
			for (const userId of [...userIds].sort()) {
				const lockUser = userId === targetUserId ? lockUserForNoKeyUpdate : lockUserForShare;
				const { rows } = await client.query<LockedUser>(lockUser, [identity.userId, userId]);
				const [user] = rows;
				if (!user) {
					throw forbidden();
				}
				lockedUsers.set(userId, user);
			}

			const actor = lockedUsers.get(identity.userId);
			const role = policy.roles.find((role) => profiles[role].databaseRole === actor?.role);
			const authorized =
				actor?.isActive &&
				actor.userId === identity.userId &&
				actor.clinicId === identity.clinicId &&
				role !== undefined &&
				authentication.roles.includes(role);
			if (!authorized) {
				throw forbidden();
			}

			const context: ActorContext = { userId: actor.userId, clinicId: actor.clinicId, role };
			if (targetUserId !== undefined) {
				context.targetUser = lockedUsers.get(targetUserId);
			}
			if (rescheduling) {
				context.originalAppointment = rescheduling.originalAppointment;
				context.destinationUser = lockedUsers.get(rescheduling.destinationUserId);
			}
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
			await client.query(profiles[role].selectRole);

			return callback(client, context, markProviderMutationSent);
		},
		pool,
	);
};
