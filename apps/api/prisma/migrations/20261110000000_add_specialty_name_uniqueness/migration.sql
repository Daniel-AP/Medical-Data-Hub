BEGIN;

ALTER TABLE public.specialties
    ADD CONSTRAINT specialties_clinic_name_key UNIQUE (clinic_id, name);

COMMIT;
