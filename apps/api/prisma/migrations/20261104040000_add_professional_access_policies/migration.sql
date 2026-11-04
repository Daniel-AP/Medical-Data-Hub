BEGIN;

GRANT SELECT ON public.professionals, public.professional_services
    TO clinic_administrator, reception, healthcare_professional;
GRANT INSERT ON public.professionals, public.professional_services TO clinic_administrator;
GRANT UPDATE (specialty_id) ON public.professionals TO clinic_administrator;
GRANT UPDATE (is_active) ON public.professional_services TO clinic_administrator;

ALTER TABLE public.professionals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.professional_services ENABLE ROW LEVEL SECURITY;

CREATE POLICY professionals_metadata_resolution_select ON public.professionals
    FOR SELECT TO medical_data_hub_metadata_owner
    USING (true);

CREATE POLICY professionals_context_select ON public.professionals
    FOR SELECT TO clinic_administrator, reception, healthcare_professional
    USING (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
    );

CREATE POLICY professionals_context_insert ON public.professionals
    FOR INSERT TO clinic_administrator
    WITH CHECK (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
    );

CREATE POLICY professionals_context_update ON public.professionals
    FOR UPDATE TO clinic_administrator
    USING (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
    )
    WITH CHECK (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
    );

CREATE POLICY professional_services_context_select ON public.professional_services
    FOR SELECT TO clinic_administrator, reception, healthcare_professional
    USING (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
    );

CREATE POLICY professional_services_context_insert ON public.professional_services
    FOR INSERT TO clinic_administrator
    WITH CHECK (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
    );

CREATE POLICY professional_services_context_update ON public.professional_services
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
