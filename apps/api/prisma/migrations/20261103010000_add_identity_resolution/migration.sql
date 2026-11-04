BEGIN;

CREATE ROLE medical_data_hub_identity_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO medical_data_hub_identity_owner, medical_data_hub_api;
GRANT SELECT (identity_id, user_id, clinic_id) ON public.users TO medical_data_hub_identity_owner;

CREATE FUNCTION public.resolve_identity(requested_identity_id text)
RETURNS TABLE (user_id uuid, clinic_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
    SELECT local_user.user_id, local_user.clinic_id
    FROM public.users AS local_user
    WHERE local_user.identity_id = requested_identity_id;
END;

REVOKE ALL ON FUNCTION public.resolve_identity(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_identity(text) TO medical_data_hub_api;
ALTER FUNCTION public.resolve_identity(text) OWNER TO medical_data_hub_identity_owner;

COMMIT;
