BEGIN;

GRANT SELECT, INSERT ON public.clinical_notes TO healthcare_professional;

ALTER TABLE public.clinical_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY clinical_notes_own_select ON public.clinical_notes
    FOR SELECT TO healthcare_professional
    USING (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
        AND EXISTS (
            SELECT 1 FROM public.appointments AS appointment
            JOIN public.professionals AS professional
                ON professional.professional_id = appointment.professional_id AND professional.clinic_id = appointment.clinic_id
            WHERE appointment.appointment_id = clinical_notes.appointment_id
                AND appointment.clinic_id = clinical_notes.clinic_id
                AND professional.user_id = NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
        )
    );

CREATE POLICY clinical_notes_own_insert ON public.clinical_notes
    FOR INSERT TO healthcare_professional
    WITH CHECK (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
        AND EXISTS (
            SELECT 1 FROM public.appointments AS appointment
            JOIN public.professionals AS professional
                ON professional.professional_id = appointment.professional_id AND professional.clinic_id = appointment.clinic_id
            WHERE appointment.appointment_id = clinical_notes.appointment_id
                AND appointment.clinic_id = clinical_notes.clinic_id
                AND professional.user_id = NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
                AND appointment.state = 'attended'
        )
    );

COMMIT;
