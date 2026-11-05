BEGIN;

GRANT SELECT (service_id, clinic_id, duration_minutes, specialty_id, is_active)
    ON public.services TO medical_data_hub_locking_owner;
GRANT UPDATE (is_active) ON public.services TO medical_data_hub_locking_owner;

CREATE POLICY services_locking_select ON public.services
    FOR SELECT TO medical_data_hub_locking_owner USING (true);
CREATE POLICY services_locking_update ON public.services
    FOR UPDATE TO medical_data_hub_locking_owner USING (true) WITH CHECK (false);

CREATE FUNCTION public.lock_service_for_share(requested_service_id uuid)
RETURNS TABLE (service_id uuid, clinic_id uuid, duration_minutes integer, specialty_id uuid, is_active boolean)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
    SELECT service.service_id, service.clinic_id, service.duration_minutes, service.specialty_id, service.is_active
    FROM public.services AS service
    WHERE service.service_id = requested_service_id
        AND NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND service.clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
    FOR SHARE OF service;
END;

REVOKE ALL ON FUNCTION public.lock_service_for_share(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_service_for_share(uuid) TO reception;
ALTER FUNCTION public.lock_service_for_share(uuid) OWNER TO medical_data_hub_locking_owner;

COMMIT;
