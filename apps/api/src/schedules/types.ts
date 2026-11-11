import type { ProfessionalSchedule } from "../generated/prisma/client.js";

export type ScheduleInterval = Pick<ProfessionalSchedule, "weekday" | "startMinute" | "endMinute">;
