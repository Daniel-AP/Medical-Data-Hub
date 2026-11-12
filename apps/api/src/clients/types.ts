import type { Clinic, Professional, Service } from "../generated/prisma/client.js";
import type { keycloakRoles } from "./keycloak-roles.js";

export type KeycloakAdminSettings = { issuer: URL; internalUrl: URL; clientId: string; clientSecret: string };
export type ClinicUserRole = Exclude<keyof typeof keycloakRoles, "platform_administrator">;

export type AvailabilityScope = Pick<Clinic, "clinicId" | "timeZone"> & Pick<Professional, "professionalId"> &
	Pick<Service, "serviceId" | "durationMinutes"> & { localDate: string; version: string };
export type AvailabilityUnit = AvailabilityScope & { starts: string[] };
