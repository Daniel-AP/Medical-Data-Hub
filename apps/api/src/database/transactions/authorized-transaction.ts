import type { Pool } from "pg";
import type { Appointment, Professional, User } from "../../generated/prisma/client.js";
import { UserRole } from "../../generated/prisma/enums.js";
import type { Authentication } from "../../middleware/types.js";
import { runTransaction } from "./run-transaction.js";
import type { TransactionClient } from "./types.js";

const databaseProfiles = {
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

const operationPolicies = {
	createPatient: {
		roles: [UserRole.clinicAdministrator, UserRole.reception],
		requiresActorProfessionalId: false,
		isolation: "readCommitted",
	},
	updatePatient: {
		roles: [UserRole.clinicAdministrator, UserRole.reception],
		requiresActorProfessionalId: false,
		isolation: "readCommitted",
	},
	readPatient: {
		roles: [UserRole.clinicAdministrator, UserRole.reception, UserRole.healthcareProfessional],
		requiresActorProfessionalId: false,
		isolation: "readCommitted",
	},
	readAppointmentCounts: {
		roles: [UserRole.clinicAdministrator],
		requiresActorProfessionalId: false,
		isolation: "readCommitted",
	},
	readClinicAgenda: {
		roles: [UserRole.reception],
		requiresActorProfessionalId: false,
		isolation: "readCommitted",
	},
	readProfessionalAgenda: {
		roles: [UserRole.reception],
		requiresActorProfessionalId: false,
		isolation: "readCommitted",
	},
	readOwnAgenda: {
		roles: [UserRole.healthcareProfessional],
		requiresActorProfessionalId: true,
		isolation: "readCommitted",
	},
	readPatientAppointmentHistory: {
		roles: [UserRole.clinicAdministrator, UserRole.reception, UserRole.healthcareProfessional],
		requiresActorProfessionalId: false,
		isolation: "readCommitted",
	},
	readAuditRecords: {
		roles: [UserRole.clinicAdministrator],
		requiresActorProfessionalId: false,
		isolation: "readCommitted",
	},
	updateUserPermissions: {
		roles: [UserRole.clinicAdministrator],
		requiresActorProfessionalId: false,
		isolation: "readCommitted",
	},
	createClinic: {
		roles: [UserRole.platformAdministrator],
		requiresActorProfessionalId: false,
		isolation: "readCommitted",
	},
	createUser: {
		roles: [UserRole.clinicAdministrator],
		requiresActorProfessionalId: false,
		isolation: "readCommitted",
	},
	createSpecialty: {
		roles: [UserRole.clinicAdministrator],
		requiresActorProfessionalId: false,
		isolation: "readCommitted",
	},
	createService: {
		roles: [UserRole.clinicAdministrator],
		requiresActorProfessionalId: false,
		isolation: "readCommitted",
	},
	updateService: {
		roles: [UserRole.clinicAdministrator],
		requiresActorProfessionalId: false,
		isolation: "readCommitted",
	},
	createProfessional: {
		roles: [UserRole.clinicAdministrator],
		requiresActorProfessionalId: false,
		isolation: "readCommitted",
	},
	updateProfessionalSpecialty: {
		roles: [UserRole.clinicAdministrator],
		requiresActorProfessionalId: false,
		isolation: "readCommitted",
	},
	createProfessionalService: {
		roles: [UserRole.clinicAdministrator],
		requiresActorProfessionalId: false,
		isolation: "readCommitted",
	},
	updateProfessionalServiceActivity: {
		roles: [UserRole.clinicAdministrator],
		requiresActorProfessionalId: false,
		isolation: "readCommitted",
	},
	replaceOwnWeeklySchedule: {
		roles: [UserRole.healthcareProfessional],
		requiresActorProfessionalId: true,
		isolation: "readCommitted",
	},
	createClinicalNote: {
		roles: [UserRole.healthcareProfessional],
		requiresActorProfessionalId: true,
		isolation: "readCommitted",
	},
	readClinicalNote: {
		roles: [UserRole.healthcareProfessional],
		requiresActorProfessionalId: true,
		isolation: "readCommitted",
	},
	rescheduleAppointment: {
		roles: [UserRole.clinicAdministrator, UserRole.reception],
		requiresActorProfessionalId: false,
		isolation: "readCommitted",
	},
	readDefinitiveAvailability: {
		roles: [UserRole.clinicAdministrator, UserRole.reception, UserRole.healthcareProfessional],
		requiresActorProfessionalId: false,
		isolation: "repeatableRead",
	},
} as const;

type ActorIdentity = Pick<User, "userId" | "clinicId">;
type LockedUser = Pick<User, "userId" | "clinicId" | "isActive"> & { role: string };
type AppointmentReferences = Pick<Appointment, "professionalId" | "patientId" | "serviceId">;
type ActorContext = Pick<User, "userId" | "clinicId" | "role"> & {
	professionalId?: Professional["professionalId"];
	targetUser?: LockedUser;
	originalAppointment?: AppointmentReferences;
	destinationUser?: LockedUser;
};

type AuthorizedOperation = { name: Exclude<keyof typeof operationPolicies, "updateUserPermissions" | "createProfessional" | "rescheduleAppointment"> }
	| { name: "updateUserPermissions" | "createProfessional"; targetUserId: string }
	| { name: "rescheduleAppointment"; appointmentId: string; destinationProfessionalId: string };

const lockUserForShareQuery = `SELECT user_id AS "userId", clinic_id AS "clinicId", role, is_active AS "isActive"
	FROM public.lock_user_for_share($1::uuid, $2::uuid)`;
const lockUserForNoKeyUpdateQuery = `SELECT user_id AS "userId", clinic_id AS "clinicId", role, is_active AS "isActive"
	FROM public.lock_user_for_no_key_update($1::uuid, $2::uuid)`;

const forbidden = () => {
	return Object.assign(new Error("Operation forbidden"), { status: 403 });
};

const resolveRescheduleReferences = async (
	client: TransactionClient,
	actorUserId: string,
	appointmentId: string,
	destinationProfessionalId: string,
) => {

	const {
		rows: [originalAppointment],
	} = await client.query<AppointmentReferences>(
		`SELECT professional_id AS "professionalId", patient_id AS "patientId", service_id AS "serviceId"
		 FROM public.resolve_appointment_references($1::uuid, $2::uuid)`,
		[actorUserId, appointmentId],
	);
	if(!originalAppointment) {
		throw forbidden();
	}

	const {
		rows: [destinationUser],
	} = await client.query<Pick<User, "userId">>(
		`SELECT user_id AS "userId" FROM public.resolve_professional_user($1::uuid, $2::uuid)`,
		[actorUserId, destinationProfessionalId],
	);
	if(!destinationUser) {
		throw forbidden();
	}

	return { originalAppointment, destinationUserId: destinationUser.userId };

};

export const runAuthorizedTransaction = async <T>(
	authentication: Authentication,
	operation: AuthorizedOperation,
	callback: (client: TransactionClient, actor: ActorContext, markKeycloakRoleUpdateStarted: () => void) => Promise<T>,
	pool?: Pool,
) => {

	const policy = operationPolicies[operation.name];
	const targetUserId = "targetUserId" in operation ? operation.targetUserId.toLowerCase() : undefined;
	const editedUserId = operation.name === "updateUserPermissions" ? targetUserId : undefined;

	return runTransaction(
		policy.isolation,
		async (client, markKeycloakRoleUpdateStarted) => {

			const {
				rows: [actorIdentity],
			} = await client.query<ActorIdentity>(
				`SELECT user_id AS "userId", clinic_id AS "clinicId" FROM public.resolve_identity($1::text)`,
				[authentication.identityId],
			);
			if(!actorIdentity) {
				throw forbidden();
			}

			const actorUserId = actorIdentity.userId;
			const userIdsToLock = new Set([actorUserId]);
			if(targetUserId !== undefined) {
				userIdsToLock.add(targetUserId);
			}

			let rescheduleReferences;
			if(operation.name === "rescheduleAppointment") {
				const { appointmentId, destinationProfessionalId } = operation;
				rescheduleReferences = await resolveRescheduleReferences(client, actorUserId, appointmentId, destinationProfessionalId);
				userIdsToLock.add(rescheduleReferences.destinationUserId);
			}

			const lockedUsers = new Map<string, LockedUser>();
			for(const userId of [...userIdsToLock].sort()) {

				const lockQuery = userId === editedUserId ? lockUserForNoKeyUpdateQuery : lockUserForShareQuery;
				const {
					rows: [lockedUser],
				} = await client.query<LockedUser>(lockQuery, [actorUserId, userId]);
				if(lockedUser) {
					lockedUsers.set(userId, lockedUser);
				} else if(operation.name !== "createProfessional" || userId === actorUserId) {
					throw forbidden();
				}

			}

			const lockedActor = lockedUsers.get(actorUserId);
			const actorRole = policy.roles.find((role) => databaseProfiles[role].databaseRole === lockedActor?.role);
			const actorIsAuthorized = lockedActor?.isActive &&
				lockedActor.userId === actorUserId &&
				lockedActor.clinicId === actorIdentity.clinicId &&
				actorRole !== undefined &&
				authentication.roles.includes(actorRole);
			if(!actorIsAuthorized) {
				throw forbidden();
			}

			const actor: ActorContext = { userId: lockedActor.userId, clinicId: lockedActor.clinicId, role: actorRole };
			if(targetUserId !== undefined) {
				actor.targetUser = lockedUsers.get(targetUserId);
			}
			if(rescheduleReferences) {
				actor.originalAppointment = rescheduleReferences.originalAppointment;
				actor.destinationUser = lockedUsers.get(rescheduleReferences.destinationUserId);
			}
			if(policy.requiresActorProfessionalId) {

				const {
					rows: [professional],
				} = await client.query<Pick<Professional, "professionalId">>(
					`SELECT professional_id AS "professionalId" FROM public.resolve_actor_professional($1::uuid)`,
					[actor.userId],
				);
				if(!professional) {
					throw forbidden();
				}
				actor.professionalId = professional.professionalId;

			}

			await client.query(
				`SELECT pg_catalog.set_config('app.user_id', $1, true),
				        pg_catalog.set_config('app.clinic_id', $2, true)`,
				[actor.userId, actor.clinicId ?? ""],
			);
			await client.query(databaseProfiles[actorRole].selectRole);

			return callback(client, actor, markKeycloakRoleUpdateStarted);

		},
		pool,
	);

};
