BEGIN;

GRANT SELECT ON public.audit_records TO clinic_administrator;
GRANT INSERT (clinic_id, user_id, patient_id, resource, appointment_id, action)
    ON public.audit_records TO clinic_administrator, reception, healthcare_professional;

ALTER TABLE public.audit_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_records_clinic_select ON public.audit_records
    FOR SELECT TO clinic_administrator
    USING (
        NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid IS NOT NULL
        AND clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
    );

CREATE POLICY audit_records_patient_contact_insert ON public.audit_records
    FOR INSERT TO clinic_administrator, reception, healthcare_professional
    WITH CHECK (
        clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
        AND user_id = NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
        AND resource = 'patient_contact'
    );

CREATE POLICY audit_records_clinical_note_insert ON public.audit_records
    FOR INSERT TO healthcare_professional
    WITH CHECK (
        clinic_id = NULLIF(pg_catalog.current_setting('app.clinic_id', true), '')::uuid
        AND user_id = NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
        AND resource = 'clinical_note'
        AND EXISTS (
            SELECT 1 FROM public.appointments AS appointment
            JOIN public.professionals AS professional
                ON professional.professional_id = appointment.professional_id AND professional.clinic_id = appointment.clinic_id
            WHERE appointment.appointment_id = audit_records.appointment_id
                AND appointment.clinic_id = audit_records.clinic_id
                AND appointment.patient_id = audit_records.patient_id
                AND professional.user_id = audit_records.user_id
        )
    );

COMMIT;
