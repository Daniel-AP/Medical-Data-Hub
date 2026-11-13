export const availabilityMetadataQuery = `SELECT service.service_id AS "serviceId", service.specialty_id AS "specialtyId",
	        service.duration_minutes AS "durationMinutes", clinic.time_zone AS "timeZone", availability.version::text AS version
	 FROM public.clinics AS clinic
	 JOIN public.services AS service USING (clinic_id)
	 LEFT JOIN public.clinic_availability_versions AS availability USING (clinic_id)
	 WHERE clinic.clinic_id = $1::uuid AND service.service_id = $2::uuid`;

export const availabilityProfessionalsQuery = `WITH candidates AS (
	     SELECT professional.professional_id,
	            COALESCE(association.is_active AND professional.specialty_id = $3::uuid
	                     AND account.is_active AND account.role = 'healthcare_professional', false) AS eligible
	     FROM public.professionals AS professional
	     JOIN public.users AS account USING (clinic_id, user_id)
	     LEFT JOIN public.professional_services AS association
	       ON association.clinic_id = professional.clinic_id AND association.professional_id = professional.professional_id
	       AND association.service_id = $2::uuid
	     WHERE professional.clinic_id = $1::uuid AND ($4::uuid IS NULL OR professional.professional_id = $4)
	 )
	 SELECT professional_id AS "professionalId", eligible FROM candidates
	 WHERE $4::uuid IS NOT NULL OR eligible ORDER BY professional_id`;

export const availabilitySchedulesQuery = `SELECT professional_id AS "professionalId", weekday, start_minute AS "startMinute", end_minute AS "endMinute"
	 FROM public.professional_schedules WHERE clinic_id = $1::uuid AND professional_id = ANY($2::uuid[])`;

export const availabilityOccupationQuery = `WITH search_windows AS (
	     SELECT span."professionalId" AS professional_id,
	            to_timestamp(span.start/1000.0) AS start_at, to_timestamp(span."end"/1000.0) AS end_at
	     FROM jsonb_to_recordset($3::jsonb) AS span("professionalId" uuid, start bigint, "end" bigint)
	 )
	 SELECT appointment.professional_id AS "professionalId", appointment.start_at AS "startAt", appointment.end_at AS "endAt"
	 FROM public.appointments AS appointment
	 WHERE appointment.clinic_id = $1::uuid AND appointment.professional_id = ANY($2::uuid[])
	   AND appointment.state = 'reserved'
	   AND EXISTS (SELECT 1 FROM search_windows AS search_window
	               WHERE search_window.professional_id = appointment.professional_id
	                 AND appointment.start_at < search_window.end_at AND appointment.end_at > search_window.start_at)
	 UNION ALL
	 SELECT block.professional_id AS "professionalId", block.start_at AS "startAt", block.end_at AS "endAt"
	 FROM public.professional_blocks AS block
	 WHERE block.clinic_id = $1::uuid AND block.professional_id = ANY($2::uuid[])
	   AND EXISTS (SELECT 1 FROM search_windows AS search_window
	               WHERE search_window.professional_id = block.professional_id
	                 AND block.start_at < search_window.end_at AND block.end_at > search_window.start_at)`;
