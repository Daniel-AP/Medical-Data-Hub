import type { Clinic, Professional } from "../generated/prisma/client.js";
import { UserRole } from "../generated/prisma/enums.js";
import type { Authentication } from "../middleware/types.js";
import { isScheduleCovered } from "./schedule-coverage.js";
import type { AppointmentConflict, ScheduleInterval } from "./types.js";
import { incrementAvailabilityVersion } from "./availability-versions.js";
import { runAuthorizedTransaction } from "./authorization.js";

export const readWeeklySchedule = (authentication: Authentication, professionalId: string) => {

	return runAuthorizedTransaction(authentication, { name: "readWeeklySchedule" }, async (transaction, actor) => {

		const { rows } = await transaction.query<ScheduleInterval | { weekday: null }>(
			`SELECT schedule.weekday, schedule.start_minute AS "startMinute", schedule.end_minute AS "endMinute"
			 FROM public.professionals AS professional
			 LEFT JOIN public.professional_schedules AS schedule USING (clinic_id, professional_id)
			 WHERE professional.clinic_id = $1::uuid AND professional.professional_id = $2::uuid
			 ORDER BY schedule.weekday, schedule.start_minute, schedule.end_minute`,
			[actor.clinicId, professionalId],
		);
		if(rows.length === 0) {
			throw Object.assign(new Error("Professional not found"), { status: 404 });
		}

		return rows.filter((interval) => interval.weekday !== null);

	});

};

export const replaceWeeklySchedule = (authentication: Authentication, professionalId: string, intervals: ScheduleInterval[]) => {

	return runAuthorizedTransaction(authentication, { name: "replaceWeeklySchedule" }, async (transaction, actor) => {

		const isProfessional = actor.role === UserRole.healthcareProfessional;
		const lockQuery = isProfessional
			? `SELECT professional_id AS "professionalId" FROM public.lock_own_professional_for_no_key_update() WHERE professional_id = $1::uuid`
			: `SELECT professional_id AS "professionalId" FROM public.professionals WHERE professional_id = $1::uuid FOR NO KEY UPDATE`;
		const { rows: [professional] } = await transaction.query<Pick<Professional, "professionalId">>(lockQuery, [professionalId]);
		if(!professional) {
			throw Object.assign(new Error("Professional unavailable for schedule replacement"), { status: isProfessional ? 403 : 404 });
		}

		const { rows: [clinic] } = await transaction.query<Pick<Clinic, "timeZone">>(
			`SELECT time_zone AS "timeZone" FROM public.clinics WHERE clinic_id = $1::uuid`,
			[actor.clinicId],
		);
		const { rows: reservations } = await transaction.query<AppointmentConflict>(
			`SELECT appointment_id AS "appointmentId", patient_id AS "patientId", service_id AS "serviceId",
			        start_at AS "startAt", end_at AS "endAt"
			 FROM public.appointments WHERE professional_id = $1::uuid AND state = 'reserved'
			 ORDER BY start_at, appointment_id`,
			[professional.professionalId],
		);
		const conflicts = reservations.filter((appointment) => !isScheduleCovered(intervals, appointment.startAt, appointment.endAt, clinic.timeZone));
		if(conflicts.length > 0) {
			return { conflicts };
		}

		await transaction.query("DELETE FROM public.professional_schedules WHERE professional_id = $1::uuid", [professional.professionalId]);
		await transaction.query(
			`INSERT INTO public.professional_schedules (clinic_id, professional_id, weekday, start_minute, end_minute)
			 SELECT $1::uuid, $2::uuid, weekday, "startMinute", "endMinute"
			 FROM jsonb_to_recordset($3::jsonb) AS interval(weekday smallint, "startMinute" smallint, "endMinute" smallint)`,
			[actor.clinicId, professional.professionalId, JSON.stringify(intervals)],
		);
		await incrementAvailabilityVersion(transaction, actor.clinicId!);

		return { conflicts: [] };

	});

};
