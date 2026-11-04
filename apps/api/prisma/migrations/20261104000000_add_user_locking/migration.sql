BEGIN;

CREATE ROLE medical_data_hub_locking_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO medical_data_hub_locking_owner;
GRANT SELECT (user_id, clinic_id, role, is_active) ON public.users TO medical_data_hub_locking_owner;
GRANT UPDATE (is_active) ON public.users TO medical_data_hub_locking_owner;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_identity_resolution_select ON public.users
    FOR SELECT TO medical_data_hub_identity_owner USING (true);
CREATE POLICY users_metadata_resolution_select ON public.users
    FOR SELECT TO medical_data_hub_metadata_owner USING (true);
CREATE POLICY users_locking_select ON public.users
    FOR SELECT TO medical_data_hub_locking_owner USING (true);
CREATE POLICY users_locking_update ON public.users
    FOR UPDATE TO medical_data_hub_locking_owner USING (true) WITH CHECK (false);

CREATE FUNCTION public.lock_user_for_share(requested_actor_user_id uuid, requested_user_id uuid)
RETURNS TABLE (user_id uuid, clinic_id uuid, role public.user_role, is_active boolean)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
    SELECT target_user.user_id, target_user.clinic_id, target_user.role, target_user.is_active
    FROM public.users AS actor
    JOIN public.users AS target_user ON target_user.user_id = requested_user_id
    WHERE actor.user_id = requested_actor_user_id
        AND (target_user.user_id = actor.user_id OR target_user.clinic_id = actor.clinic_id)
    FOR SHARE OF target_user;
END;

CREATE FUNCTION public.lock_user_for_no_key_update(requested_actor_user_id uuid, requested_user_id uuid)
RETURNS TABLE (user_id uuid, clinic_id uuid, role public.user_role, is_active boolean)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
    SELECT target_user.user_id, target_user.clinic_id, target_user.role, target_user.is_active
    FROM public.users AS actor
    JOIN public.users AS target_user ON target_user.user_id = requested_user_id
    WHERE actor.user_id = requested_actor_user_id
        AND (target_user.user_id = actor.user_id OR target_user.clinic_id = actor.clinic_id)
    FOR NO KEY UPDATE OF target_user;
END;

REVOKE ALL ON FUNCTION public.lock_user_for_share(uuid, uuid), public.lock_user_for_no_key_update(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_user_for_share(uuid, uuid), public.lock_user_for_no_key_update(uuid, uuid)
    TO medical_data_hub_api;

ALTER FUNCTION public.lock_user_for_share(uuid, uuid) OWNER TO medical_data_hub_locking_owner;
ALTER FUNCTION public.lock_user_for_no_key_update(uuid, uuid) OWNER TO medical_data_hub_locking_owner;

COMMIT;
