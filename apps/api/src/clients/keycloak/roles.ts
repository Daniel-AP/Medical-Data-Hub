import { UserRole } from "../../generated/prisma/enums.js";

export const keycloakRoles = {
	platform_administrator: UserRole.platformAdministrator,
	clinic_administrator: UserRole.clinicAdministrator,
	reception: UserRole.reception,
	healthcare_professional: UserRole.healthcareProfessional,
};
