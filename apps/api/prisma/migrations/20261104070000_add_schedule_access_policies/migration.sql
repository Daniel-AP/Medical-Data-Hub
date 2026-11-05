BEGIN;

GRANT SELECT ON public.professional_schedules, public.professional_blocks
    TO clinic_administrator, reception, healthcare_professional;
GRANT INSERT, DELETE ON public.professional_schedules TO clinic_administrator, healthcare_professional;
GRANT UPDATE (weekday, start_minute, end_minute) ON public.professional_schedules
    TO clinic_administrator, healthcare_professional;
GRANT INSERT ON public.professional_blocks TO clinic_administrator, healthcare_professional;

ALTER TABLE public.professional_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.professional_blocks ENABLE ROW LEVEL SECURITY;

CREATE POLICY professional_schedules_context_select ON public.professional_schedules
    FOR SELECT TO clinic_administrator, reception, healthcare_professional
    USING (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
    );

CREATE POLICY professional_schedules_administrator_insert ON public.professional_schedules
    FOR INSERT TO clinic_administrator
    WITH CHECK (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
    );

CREATE POLICY professional_schedules_own_insert ON public.professional_schedules
    FOR INSERT TO healthcare_professional
    WITH CHECK (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
        AND EXISTS (
            SELECT 1 FROM public.professionals AS professional
            WHERE professional.professional_id = professional_schedules.professional_id
                AND professional.clinic_id = professional_schedules.clinic_id
                AND professional.user_id = NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
        )
    );

CREATE POLICY professional_schedules_administrator_update ON public.professional_schedules
    FOR UPDATE TO clinic_administrator
    USING (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
    )
    WITH CHECK (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
    );

CREATE POLICY professional_schedules_own_update ON public.professional_schedules
    FOR UPDATE TO healthcare_professional
    USING (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
        AND EXISTS (
            SELECT 1 FROM public.professionals AS professional
            WHERE professional.professional_id = professional_schedules.professional_id
                AND professional.clinic_id = professional_schedules.clinic_id
                AND professional.user_id = NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
        )
    )
    WITH CHECK (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
        AND EXISTS (
            SELECT 1 FROM public.professionals AS professional
            WHERE professional.professional_id = professional_schedules.professional_id
                AND professional.clinic_id = professional_schedules.clinic_id
                AND professional.user_id = NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
        )
    );

CREATE POLICY professional_schedules_administrator_delete ON public.professional_schedules
    FOR DELETE TO clinic_administrator
    USING (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
    );

CREATE POLICY professional_schedules_own_delete ON public.professional_schedules
    FOR DELETE TO healthcare_professional
    USING (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
        AND EXISTS (
            SELECT 1 FROM public.professionals AS professional
            WHERE professional.professional_id = professional_schedules.professional_id
                AND professional.clinic_id = professional_schedules.clinic_id
                AND professional.user_id = NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
        )
    );

CREATE POLICY professional_blocks_context_select ON public.professional_blocks
    FOR SELECT TO clinic_administrator, reception, healthcare_professional
    USING (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
    );

CREATE POLICY professional_blocks_administrator_insert ON public.professional_blocks
    FOR INSERT TO clinic_administrator
    WITH CHECK (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
    );

CREATE POLICY professional_blocks_own_insert ON public.professional_blocks
    FOR INSERT TO healthcare_professional
    WITH CHECK (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
        AND EXISTS (
            SELECT 1 FROM public.professionals AS professional
            WHERE professional.professional_id = professional_blocks.professional_id
                AND professional.clinic_id = professional_blocks.clinic_id
                AND professional.user_id = NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
        )
    );

COMMIT;
