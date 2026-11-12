import type { keycloakRoles } from "./keycloak-roles.js";

export type KeycloakAdminSettings = { issuer: URL; internalUrl: URL; clientId: string; clientSecret: string };
export type ClinicUserRole = Exclude<keyof typeof keycloakRoles, "platform_administrator">;
