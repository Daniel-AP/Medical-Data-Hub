import type { Appointment, ProfessionalSchedule } from "../generated/prisma/client.js";

export type AppointmentConflict = Pick<Appointment, "appointmentId" | "patientId" | "serviceId" | "startAt" | "endAt">;
export type ScheduleInterval = Pick<ProfessionalSchedule, "weekday" | "startMinute" | "endMinute">;
