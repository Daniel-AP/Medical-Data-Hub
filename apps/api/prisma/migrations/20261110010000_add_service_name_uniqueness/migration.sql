BEGIN;

ALTER TABLE public.services
    ADD CONSTRAINT services_clinic_name_key UNIQUE (clinic_id, name);

COMMIT;
