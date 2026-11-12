import { UserRole } from "../generated/prisma/enums.js";
import type { ClinicUserRole } from "./types.js";

const clinicUserRoles = {
	clinic_administrator: UserRole.clinicAdministrator,
	reception: UserRole.reception,
	healthcare_professional: UserRole.healthcareProfessional,
};

export const keycloakRoles = {
	platform_administrator: UserRole.platformAdministrator,
	...clinicUserRoles,
};

export const isClinicUserRole = (role: unknown): role is ClinicUserRole => {
	return typeof role === "string" && Object.hasOwn(clinicUserRoles, role);
};
