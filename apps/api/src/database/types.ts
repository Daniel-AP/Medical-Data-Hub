import type { PoolClient } from "pg";
import type { Appointment, ProfessionalSchedule } from "../generated/prisma/client.js";

export type TransactionClient = Pick<PoolClient, "query">;
export type TransactionStage = "acquire" | "begin" | "operation" | "commit";
export type ScheduleInterval = Pick<ProfessionalSchedule, "weekday" | "startMinute" | "endMinute">;
export type AppointmentConflict = Pick<Appointment, "appointmentId" | "patientId" | "serviceId" | "startAt" | "endAt">;
