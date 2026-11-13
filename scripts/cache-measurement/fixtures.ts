import type { Pool } from "pg";

type ClinicFixtures = {
	name: string;
	professionals: number;
	appointments: number;
	firstDate: string | null;
	lastDate: string | null;
};

type ServiceScope = {
	clinicId: string;
	clinicName: string;
	timeZone: string;
	version: string;
	serviceId: string;
	serviceName: string;
	durationMinutes: number;
	professionalId: string;
};

export const readFixtures = async (database: Pool, identityId: string) => {

	const { rows: clinics } = await database.query<ClinicFixtures>(
		`SELECT c.name,
		        (SELECT count(*)::int FROM professionals p WHERE p.clinic_id = c.clinic_id) AS professionals,
		        count(a.appointment_id)::int AS appointments,
		        min((a.start_at AT TIME ZONE c.time_zone)::date)::text AS "firstDate",
		        max((a.start_at AT TIME ZONE c.time_zone)::date)::text AS "lastDate"
		 FROM clinics c LEFT JOIN appointments a USING (clinic_id)
		 GROUP BY c.clinic_id ORDER BY c.name`,
	);
	const incomplete = clinics.some((clinic) =>
		clinic.professionals < 2 || clinic.appointments < 2 || !clinic.firstDate || clinic.firstDate === clinic.lastDate,
	);
	if(clinics.length < 3 || incomplete) {
		throw new Error("The seed must contain three clinics with multiple professionals and appointments across dates");
	}

	const { rows: eligible } = await database.query<ServiceScope>(
		`SELECT c.clinic_id AS "clinicId", c.name AS "clinicName", c.time_zone AS "timeZone", v.version::text,
		        s.service_id AS "serviceId", s.name AS "serviceName", s.duration_minutes AS "durationMinutes",
		        p.professional_id AS "professionalId"
		 FROM users actor
		 JOIN clinics c USING (clinic_id)
		 JOIN clinic_availability_versions v USING (clinic_id)
		 JOIN services s USING (clinic_id)
		 JOIN professional_services ps USING (clinic_id, service_id)
		 JOIN professionals p USING (clinic_id, professional_id)
		 JOIN users account ON account.clinic_id = p.clinic_id AND account.user_id = p.user_id
		 WHERE actor.identity_id = $1 AND actor.is_active AND actor.role = 'reception'
		   AND c.name = 'Clínica Central' AND s.name = 'Consulta general' AND s.is_active
		   AND ps.is_active AND p.specialty_id = s.specialty_id AND account.is_active AND account.role = 'healthcare_professional'
		 ORDER BY account.identity_id`,
		[identityId],
	);
	if(eligible.length < 2) {
		throw new Error("The reception fixture must have multiple eligible professionals for Consulta general");
	}

	const [scope] = eligible;
	const { clinicId, professionalId, serviceId, timeZone } = scope;
	const { rows: [anchor] } = await database.query<{ from: string; to: string }>(
		`SELECT week_start::text AS "from", (week_start+6)::text AS "to"
		 FROM (
		     SELECT date_trunc('week', start_at AT TIME ZONE $4)::date AS week_start
		     FROM appointments
		     WHERE clinic_id = $1 AND professional_id = $2 AND service_id = $3
		       AND state = 'reserved' AND start_at > CURRENT_TIMESTAMP
		     ORDER BY start_at LIMIT 1
		 ) AS reserved_week
		 WHERE week_start > (CURRENT_TIMESTAMP AT TIME ZONE $4)::date`,
		[clinicId, professionalId, serviceId, timeZone],
	);
	if(!anchor) {
		throw new Error("The selected professional must have a seeded reservation in a future week");
	}

	const { rows: indexes } = await database.query<{ indexdef: string }>(
		"SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname",
	);
	const { rows: [{ server_version: postgresVersion }] } = await database.query<{ server_version: string }>("SHOW server_version");

	return { clinics, scope, professionalIds: eligible.map((row) => row.professionalId), ...anchor, indexes, postgresVersion };

};

export const verifyAvailabilityVersion = async (database: Pool, { clinicId, version }: ServiceScope) => {

	const { rows: [current] } = await database.query<{ version: string }>(
		"SELECT version::text FROM clinic_availability_versions WHERE clinic_id = $1", [clinicId],
	);
	if(current?.version !== version) {
		throw new Error("The clinic availability version changed during measurement");
	}

};
