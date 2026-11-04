BEGIN;

CREATE ROLE medical_data_hub_metadata_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO medical_data_hub_metadata_owner;
GRANT SELECT (user_id, clinic_id) ON public.users TO medical_data_hub_metadata_owner;
GRANT SELECT (professional_id, clinic_id, user_id) ON public.professionals TO medical_data_hub_metadata_owner;
GRANT SELECT (appointment_id, clinic_id, professional_id, patient_id, service_id)
    ON public.appointments TO medical_data_hub_metadata_owner;

CREATE FUNCTION public.resolve_actor_professional(requested_actor_user_id uuid)
RETURNS TABLE (professional_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
    SELECT professional.professional_id
    FROM public.users AS actor
    JOIN public.professionals AS professional
        ON professional.user_id = actor.user_id AND professional.clinic_id = actor.clinic_id
    WHERE actor.user_id = requested_actor_user_id;
END;

CREATE FUNCTION public.resolve_professional_user(requested_actor_user_id uuid, requested_professional_id uuid)
RETURNS TABLE (user_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
    SELECT professional.user_id
    FROM public.users AS actor
    JOIN public.professionals AS professional ON professional.clinic_id = actor.clinic_id
    WHERE actor.user_id = requested_actor_user_id AND professional.professional_id = requested_professional_id;
END;

CREATE FUNCTION public.resolve_appointment_references(requested_actor_user_id uuid, requested_appointment_id uuid)
RETURNS TABLE (professional_id uuid, patient_id uuid, service_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
    SELECT appointment.professional_id, appointment.patient_id, appointment.service_id
    FROM public.users AS actor
    JOIN public.appointments AS appointment ON appointment.clinic_id = actor.clinic_id
    WHERE actor.user_id = requested_actor_user_id AND appointment.appointment_id = requested_appointment_id;
END;

REVOKE ALL ON FUNCTION public.resolve_actor_professional(uuid), public.resolve_professional_user(uuid, uuid),
    public.resolve_appointment_references(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_actor_professional(uuid), public.resolve_professional_user(uuid, uuid),
    public.resolve_appointment_references(uuid, uuid) TO medical_data_hub_api;

ALTER FUNCTION public.resolve_actor_professional(uuid) OWNER TO medical_data_hub_metadata_owner;
ALTER FUNCTION public.resolve_professional_user(uuid, uuid) OWNER TO medical_data_hub_metadata_owner;
ALTER FUNCTION public.resolve_appointment_references(uuid, uuid) OWNER TO medical_data_hub_metadata_owner;

COMMIT;
