BEGIN;

GRANT SELECT ON public.appointments TO clinic_administrator, reception, healthcare_professional;
GRANT INSERT ON public.appointments TO clinic_administrator, reception;
GRANT UPDATE (state, cancelled_by_user_id, cancellation_reason) ON public.appointments
    TO clinic_administrator, reception;
GRANT UPDATE (state) ON public.appointments TO healthcare_professional;

ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;

CREATE POLICY appointments_metadata_resolution_select ON public.appointments
    FOR SELECT TO medical_data_hub_metadata_owner USING (true);

CREATE POLICY appointments_context_select ON public.appointments
    FOR SELECT TO clinic_administrator, reception, healthcare_professional
    USING (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
    );

CREATE POLICY appointments_context_insert ON public.appointments
    FOR INSERT TO clinic_administrator, reception
    WITH CHECK (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
    );

CREATE POLICY appointments_context_update ON public.appointments
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
