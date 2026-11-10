import { UserRole } from "../../generated/prisma/enums.js";

const clinicUserRoles = {
	clinic_administrator: UserRole.clinicAdministrator,
	reception: UserRole.reception,
	healthcare_professional: UserRole.healthcareProfessional,
};

export const keycloakRoles = {
	platform_administrator: UserRole.platformAdministrator,
	...clinicUserRoles,
};

export type ClinicUserRole = keyof typeof clinicUserRoles;

export const isClinicUserRole = (role: unknown): role is ClinicUserRole => {
	return typeof role === "string" && Object.hasOwn(clinicUserRoles, role);
};
