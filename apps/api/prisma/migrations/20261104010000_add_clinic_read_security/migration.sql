BEGIN;

GRANT SELECT (clinic_id, time_zone) ON public.clinics
    TO clinic_administrator, reception, healthcare_professional;

ALTER TABLE public.clinics ENABLE ROW LEVEL SECURITY;

CREATE POLICY clinics_context_select ON public.clinics
    FOR SELECT TO clinic_administrator, reception, healthcare_professional
    USING (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
    );

COMMIT;
