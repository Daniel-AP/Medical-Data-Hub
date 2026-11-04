BEGIN;

GRANT SELECT, INSERT ON public.users TO clinic_administrator;
GRANT UPDATE (role, is_active) ON public.users TO clinic_administrator;
GRANT SELECT (user_id, clinic_id, role, is_active) ON public.users TO reception, healthcare_professional;

CREATE POLICY users_context_select ON public.users
    FOR SELECT TO clinic_administrator, reception, healthcare_professional
    USING (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
    );

CREATE POLICY users_context_insert ON public.users
    FOR INSERT TO clinic_administrator
    WITH CHECK (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
    );

CREATE POLICY users_context_update ON public.users
    FOR UPDATE TO clinic_administrator
    USING (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
    )
    WITH CHECK (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
    );

COMMIT;
