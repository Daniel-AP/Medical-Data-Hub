BEGIN;

GRANT SELECT ON public.clinic_availability_versions TO clinic_administrator, reception, healthcare_professional;
GRANT UPDATE (version) ON public.clinic_availability_versions TO clinic_administrator, reception, healthcare_professional;

ALTER TABLE public.clinic_availability_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY clinic_availability_versions_context_select ON public.clinic_availability_versions
    FOR SELECT TO clinic_administrator, reception, healthcare_professional
    USING (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
    );

CREATE POLICY clinic_availability_versions_context_update ON public.clinic_availability_versions
    FOR UPDATE TO clinic_administrator, reception, healthcare_professional
    USING (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
    )
    WITH CHECK (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
    );

COMMIT;
