BEGIN;

CREATE ROLE medical_data_hub_clinic_creation_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO medical_data_hub_clinic_creation_owner;
GRANT INSERT (clinic_id, name, time_zone), SELECT (clinic_id)
    ON public.clinics TO medical_data_hub_clinic_creation_owner;
GRANT INSERT (user_id, clinic_id, identity_id, role), SELECT (user_id)
    ON public.users TO medical_data_hub_clinic_creation_owner;
GRANT INSERT (clinic_id) ON public.clinic_availability_versions TO medical_data_hub_clinic_creation_owner;

CREATE POLICY clinics_creation_insert ON public.clinics
    FOR INSERT TO medical_data_hub_clinic_creation_owner
    WITH CHECK (clinic_id = NULLIF(pg_catalog.current_setting('app.new_clinic_id', true), '')::uuid);

CREATE POLICY clinics_creation_select ON public.clinics
    FOR SELECT TO medical_data_hub_clinic_creation_owner
    USING (clinic_id = NULLIF(pg_catalog.current_setting('app.new_clinic_id', true), '')::uuid);

CREATE POLICY users_clinic_creation_insert ON public.users
    FOR INSERT TO medical_data_hub_clinic_creation_owner
    WITH CHECK (
        clinic_id = NULLIF(pg_catalog.current_setting('app.new_clinic_id', true), '')::uuid
        AND user_id = NULLIF(pg_catalog.current_setting('app.new_clinic_administrator_id', true), '')::uuid
        AND role = 'clinic_administrator'
        AND is_active
    );

CREATE POLICY users_clinic_creation_select ON public.users
    FOR SELECT TO medical_data_hub_clinic_creation_owner
    USING (
        clinic_id = NULLIF(pg_catalog.current_setting('app.new_clinic_id', true), '')::uuid
        AND user_id = NULLIF(pg_catalog.current_setting('app.new_clinic_administrator_id', true), '')::uuid
    );

CREATE POLICY clinic_availability_versions_creation_insert ON public.clinic_availability_versions
    FOR INSERT TO medical_data_hub_clinic_creation_owner
    WITH CHECK (
        clinic_id = NULLIF(pg_catalog.current_setting('app.new_clinic_id', true), '')::uuid
        AND version = 0
    );

CREATE FUNCTION public.create_clinic(requested_name text, requested_time_zone text, requested_administrator_identity_id text)
RETURNS TABLE (clinic_id uuid, user_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET app.new_clinic_id = ''
SET app.new_clinic_administrator_id = ''
AS $$
DECLARE
    new_clinic_id uuid := pg_catalog.gen_random_uuid();
    new_administrator_id uuid := pg_catalog.gen_random_uuid();
BEGIN
    PERFORM pg_catalog.set_config('app.new_clinic_id', new_clinic_id::text, true);
    PERFORM pg_catalog.set_config('app.new_clinic_administrator_id', new_administrator_id::text, true);

    INSERT INTO public.clinics AS clinic (clinic_id, name, time_zone)
    VALUES (new_clinic_id, requested_name, requested_time_zone)
    RETURNING clinic.clinic_id INTO clinic_id;

    INSERT INTO public.users AS administrator (user_id, clinic_id, identity_id, role)
    VALUES (new_administrator_id, new_clinic_id, requested_administrator_identity_id, 'clinic_administrator')
    RETURNING administrator.user_id INTO user_id;

    INSERT INTO public.clinic_availability_versions (clinic_id)
    VALUES (new_clinic_id);

    RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.create_clinic(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_clinic(text, text, text) TO platform_administrator;
ALTER FUNCTION public.create_clinic(text, text, text) OWNER TO medical_data_hub_clinic_creation_owner;

COMMIT;
