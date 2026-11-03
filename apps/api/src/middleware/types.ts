import type { UserRole } from "../generated/prisma/enums.js";

export type Authentication = { identityId: string; roles: UserRole[] };
