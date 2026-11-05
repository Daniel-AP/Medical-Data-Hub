BEGIN;

GRANT SELECT (professional_id, clinic_id, user_id, specialty_id)
    ON public.professionals TO medical_data_hub_locking_owner;
GRANT UPDATE (specialty_id) ON public.professionals TO medical_data_hub_locking_owner;

CREATE POLICY professionals_locking_select ON public.professionals
    FOR SELECT TO medical_data_hub_locking_owner USING (true);
CREATE POLICY professionals_locking_update ON public.professionals
    FOR UPDATE TO medical_data_hub_locking_owner USING (true) WITH CHECK (false);

CREATE FUNCTION public.lock_professional_for_no_key_update(requested_professional_id uuid)
RETURNS TABLE (professional_id uuid, clinic_id uuid, user_id uuid, specialty_id uuid)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
    SELECT professional.professional_id, professional.clinic_id, professional.user_id, professional.specialty_id
    FROM public.professionals AS professional
    WHERE professional.professional_id = requested_professional_id
        AND NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND professional.clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
    FOR NO KEY UPDATE OF professional;
END;

CREATE FUNCTION public.lock_own_professional_for_no_key_update()
RETURNS TABLE (professional_id uuid, clinic_id uuid, user_id uuid, specialty_id uuid)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
    SELECT professional.professional_id, professional.clinic_id, professional.user_id, professional.specialty_id
    FROM public.professionals AS professional
    WHERE professional.user_id = NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
        AND professional.clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
    FOR NO KEY UPDATE OF professional;
END;

REVOKE ALL ON FUNCTION public.lock_professional_for_no_key_update(uuid),
    public.lock_own_professional_for_no_key_update() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_professional_for_no_key_update(uuid) TO reception;
GRANT EXECUTE ON FUNCTION public.lock_own_professional_for_no_key_update() TO healthcare_professional;

ALTER FUNCTION public.lock_professional_for_no_key_update(uuid) OWNER TO medical_data_hub_locking_owner;
ALTER FUNCTION public.lock_own_professional_for_no_key_update() OWNER TO medical_data_hub_locking_owner;

COMMIT;
