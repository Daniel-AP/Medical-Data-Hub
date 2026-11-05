BEGIN;

GRANT SELECT ON public.patients TO clinic_administrator, reception, healthcare_professional;
GRANT INSERT ON public.patients TO clinic_administrator, reception;
GRANT UPDATE (identification, name, date_of_birth, email, phone) ON public.patients
    TO clinic_administrator, reception;

ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY;

CREATE POLICY patients_context_select ON public.patients
    FOR SELECT TO clinic_administrator, reception, healthcare_professional
    USING (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
    );

CREATE POLICY patients_context_insert ON public.patients
    FOR INSERT TO clinic_administrator, reception
    WITH CHECK (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
    );

CREATE POLICY patients_context_update ON public.patients
    FOR UPDATE TO clinic_administrator, reception
    USING (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
    )
    WITH CHECK (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
    );

COMMIT;
