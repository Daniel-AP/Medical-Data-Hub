BEGIN;

CREATE INDEX appointments_reserved_idx
ON public.appointments (clinic_id, professional_id)
WHERE state = 'reserved';

CREATE INDEX professional_blocks_idx
ON public.professional_blocks (clinic_id, professional_id);

CREATE INDEX professional_schedules_idx
ON public.professional_schedules (clinic_id, professional_id);

COMMIT;
