BEGIN;

CREATE FUNCTION public.reject_audit_record_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION 'audit_records is append-only' USING ERRCODE = '55000';
END;
$$;

REVOKE ALL ON FUNCTION public.reject_audit_record_mutation() FROM PUBLIC;

CREATE TRIGGER audit_records_append_only_guard
    BEFORE UPDATE OR DELETE OR TRUNCATE ON public.audit_records
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.reject_audit_record_mutation();

COMMIT;
