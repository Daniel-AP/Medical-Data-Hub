-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('platform_administrator', 'clinic_administrator', 'reception', 'healthcare_professional');

-- CreateEnum
CREATE TYPE "appointment_state" AS ENUM ('reserved', 'attended', 'absent', 'cancelled', 'rescheduled');

-- CreateEnum
CREATE TYPE "audit_resource" AS ENUM ('patient_contact', 'clinical_note');

-- CreateEnum
CREATE TYPE "audit_action" AS ENUM ('read', 'write');

-- CreateTable
CREATE TABLE "clinics" (
    "clinic_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(200) NOT NULL,
    "time_zone" VARCHAR(64) NOT NULL,

    CONSTRAINT "clinics_pkey" PRIMARY KEY ("clinic_id")
);

-- CreateTable
CREATE TABLE "clinic_availability_versions" (
    "clinic_id" UUID NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "clinic_availability_versions_pkey" PRIMARY KEY ("clinic_id")
);

-- CreateTable
CREATE TABLE "users" (
    "user_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "identity_id" VARCHAR(255) NOT NULL,
    "clinic_id" UUID,
    "role" "user_role" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "users_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "role_sync_tasks" (
    "role_sync_task_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "role_sync_tasks_pkey" PRIMARY KEY ("role_sync_task_id")
);

-- CreateTable
CREATE TABLE "specialties" (
    "specialty_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,

    CONSTRAINT "specialties_pkey" PRIMARY KEY ("specialty_id")
);

-- CreateTable
CREATE TABLE "professionals" (
    "professional_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "specialty_id" UUID NOT NULL,

    CONSTRAINT "professionals_pkey" PRIMARY KEY ("professional_id")
);

-- CreateTable
CREATE TABLE "services" (
    "service_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "specialty_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "services_pkey" PRIMARY KEY ("service_id")
);

-- CreateTable
CREATE TABLE "professional_services" (
    "clinic_id" UUID NOT NULL,
    "professional_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "professional_services_pkey" PRIMARY KEY ("clinic_id","professional_id","service_id")
);

-- CreateTable
CREATE TABLE "professional_schedules" (
    "professional_schedule_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "professional_id" UUID NOT NULL,
    "weekday" SMALLINT NOT NULL,
    "start_minute" SMALLINT NOT NULL,
    "end_minute" SMALLINT NOT NULL,

    CONSTRAINT "professional_schedules_pkey" PRIMARY KEY ("professional_schedule_id")
);

-- CreateTable
CREATE TABLE "professional_blocks" (
    "professional_block_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "professional_id" UUID NOT NULL,
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "end_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "professional_blocks_pkey" PRIMARY KEY ("professional_block_id")
);

-- CreateTable
CREATE TABLE "patients" (
    "patient_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "identification" VARCHAR(50) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "date_of_birth" DATE NOT NULL,
    "email" VARCHAR(320),
    "phone" VARCHAR(32),

    CONSTRAINT "patients_pkey" PRIMARY KEY ("patient_id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "appointment_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "professional_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "end_at" TIMESTAMPTZ(3) NOT NULL,
    "state" "appointment_state" NOT NULL DEFAULT 'reserved',
    "previous_appointment_id" UUID,
    "cancelled_by_user_id" UUID,
    "cancellation_reason" VARCHAR(500),

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("appointment_id")
);

-- CreateTable
CREATE TABLE "clinical_notes" (
    "appointment_id" UUID NOT NULL,
    "clinic_id" UUID NOT NULL,
    "content" TEXT NOT NULL,

    CONSTRAINT "clinical_notes_pkey" PRIMARY KEY ("appointment_id")
);

-- CreateTable
CREATE TABLE "audit_records" (
    "audit_record_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "resource" "audit_resource" NOT NULL,
    "appointment_id" UUID,
    "action" "audit_action" NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "audit_records_pkey" PRIMARY KEY ("audit_record_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_identity_id_key" ON "users"("identity_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_clinic_user_key" ON "users"("clinic_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "specialties_clinic_specialty_key" ON "specialties"("clinic_id", "specialty_id");

-- CreateIndex
CREATE UNIQUE INDEX "professionals_clinic_professional_key" ON "professionals"("clinic_id", "professional_id");

-- CreateIndex
CREATE UNIQUE INDEX "professionals_user_key" ON "professionals"("clinic_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "services_clinic_service_key" ON "services"("clinic_id", "service_id");

-- CreateIndex
CREATE UNIQUE INDEX "patients_clinic_patient_key" ON "patients"("clinic_id", "patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "patients_identification_key" ON "patients"("clinic_id", "identification");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_clinic_appointment_key" ON "appointments"("clinic_id", "appointment_id");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_replacement_target_key" ON "appointments"("clinic_id", "appointment_id", "patient_id", "service_id");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_previous_key" ON "appointments"("clinic_id", "previous_appointment_id");

-- CreateIndex
CREATE UNIQUE INDEX "clinical_notes_clinic_appointment_key" ON "clinical_notes"("clinic_id", "appointment_id");

-- AddForeignKey
ALTER TABLE "clinic_availability_versions" ADD CONSTRAINT "clinic_availability_versions_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("clinic_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("clinic_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "role_sync_tasks" ADD CONSTRAINT "role_sync_tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "specialties" ADD CONSTRAINT "specialties_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("clinic_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "professionals" ADD CONSTRAINT "professionals_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("clinic_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "professionals" ADD CONSTRAINT "professionals_clinic_id_user_id_fkey" FOREIGN KEY ("clinic_id", "user_id") REFERENCES "users"("clinic_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "professionals" ADD CONSTRAINT "professionals_clinic_id_specialty_id_fkey" FOREIGN KEY ("clinic_id", "specialty_id") REFERENCES "specialties"("clinic_id", "specialty_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("clinic_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_clinic_id_specialty_id_fkey" FOREIGN KEY ("clinic_id", "specialty_id") REFERENCES "specialties"("clinic_id", "specialty_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "professional_services" ADD CONSTRAINT "professional_services_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("clinic_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "professional_services" ADD CONSTRAINT "professional_services_clinic_id_professional_id_fkey" FOREIGN KEY ("clinic_id", "professional_id") REFERENCES "professionals"("clinic_id", "professional_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "professional_services" ADD CONSTRAINT "professional_services_clinic_id_service_id_fkey" FOREIGN KEY ("clinic_id", "service_id") REFERENCES "services"("clinic_id", "service_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "professional_schedules" ADD CONSTRAINT "professional_schedules_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("clinic_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "professional_schedules" ADD CONSTRAINT "professional_schedules_clinic_id_professional_id_fkey" FOREIGN KEY ("clinic_id", "professional_id") REFERENCES "professionals"("clinic_id", "professional_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "professional_blocks" ADD CONSTRAINT "professional_blocks_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("clinic_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "professional_blocks" ADD CONSTRAINT "professional_blocks_clinic_id_professional_id_fkey" FOREIGN KEY ("clinic_id", "professional_id") REFERENCES "professionals"("clinic_id", "professional_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "patients" ADD CONSTRAINT "patients_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("clinic_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("clinic_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_clinic_id_patient_id_fkey" FOREIGN KEY ("clinic_id", "patient_id") REFERENCES "patients"("clinic_id", "patient_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_clinic_id_professional_id_fkey" FOREIGN KEY ("clinic_id", "professional_id") REFERENCES "professionals"("clinic_id", "professional_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_clinic_id_service_id_fkey" FOREIGN KEY ("clinic_id", "service_id") REFERENCES "services"("clinic_id", "service_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_clinic_id_professional_id_service_id_fkey" FOREIGN KEY ("clinic_id", "professional_id", "service_id") REFERENCES "professional_services"("clinic_id", "professional_id", "service_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_clinic_id_previous_appointment_id_patient_id__fkey" FOREIGN KEY ("clinic_id", "previous_appointment_id", "patient_id", "service_id") REFERENCES "appointments"("clinic_id", "appointment_id", "patient_id", "service_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_clinic_id_cancelled_by_user_id_fkey" FOREIGN KEY ("clinic_id", "cancelled_by_user_id") REFERENCES "users"("clinic_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "clinical_notes" ADD CONSTRAINT "clinical_notes_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("clinic_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "clinical_notes" ADD CONSTRAINT "clinical_notes_clinic_id_appointment_id_fkey" FOREIGN KEY ("clinic_id", "appointment_id") REFERENCES "appointments"("clinic_id", "appointment_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "audit_records" ADD CONSTRAINT "audit_records_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("clinic_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "audit_records" ADD CONSTRAINT "audit_records_clinic_id_user_id_fkey" FOREIGN KEY ("clinic_id", "user_id") REFERENCES "users"("clinic_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "audit_records" ADD CONSTRAINT "audit_records_clinic_id_patient_id_fkey" FOREIGN KEY ("clinic_id", "patient_id") REFERENCES "patients"("clinic_id", "patient_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "audit_records" ADD CONSTRAINT "audit_records_clinic_id_appointment_id_fkey" FOREIGN KEY ("clinic_id", "appointment_id") REFERENCES "clinical_notes"("clinic_id", "appointment_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddCheckConstraints
ALTER TABLE "clinics"
    ADD CONSTRAINT "clinics_name_check" CHECK ("name" <> '');

ALTER TABLE "clinic_availability_versions"
    ADD CONSTRAINT "clinic_availability_versions_version_check" CHECK ("version" >= 0);

ALTER TABLE "users"
    ADD CONSTRAINT "users_role_clinic_check" CHECK (
        ("role" = 'platform_administrator' AND "clinic_id" IS NULL)
        OR ("role" <> 'platform_administrator' AND "clinic_id" IS NOT NULL)
    );

ALTER TABLE "specialties"
    ADD CONSTRAINT "specialties_name_check" CHECK ("name" <> '');

ALTER TABLE "services"
    ADD CONSTRAINT "services_name_check" CHECK ("name" <> ''),
    ADD CONSTRAINT "services_duration_check" CHECK ("duration_minutes" > 0);

ALTER TABLE "professional_schedules"
    ADD CONSTRAINT "professional_schedules_weekday_check" CHECK ("weekday" BETWEEN 1 AND 7),
    ADD CONSTRAINT "professional_schedules_interval_check" CHECK (
        "start_minute" >= 0 AND "end_minute" <= 1440 AND "start_minute" < "end_minute"
    );

ALTER TABLE "professional_blocks"
    ADD CONSTRAINT "professional_blocks_interval_check" CHECK (
        isfinite("start_at") AND isfinite("end_at") AND "start_at" < "end_at"
    );

ALTER TABLE "patients"
    ADD CONSTRAINT "patients_identification_check" CHECK ("identification" <> ''),
    ADD CONSTRAINT "patients_name_check" CHECK ("name" <> ''),
    ADD CONSTRAINT "patients_contact_check" CHECK (
        ("email" IS NOT NULL OR "phone" IS NOT NULL)
        AND ("email" IS NULL OR "email" <> '')
        AND ("phone" IS NULL OR "phone" <> '')
    );

ALTER TABLE "appointments"
    ADD CONSTRAINT "appointments_interval_check" CHECK ("start_at" < "end_at"),
    ADD CONSTRAINT "appointments_minute_check" CHECK (
        isfinite("start_at") AND EXTRACT(SECOND FROM "start_at" AT TIME ZONE 'UTC') = 0
    ),
    ADD CONSTRAINT "appointments_previous_check" CHECK ("previous_appointment_id" <> "appointment_id"),
    ADD CONSTRAINT "appointments_cancellation_check" CHECK (
        (
            "state" = 'cancelled'
            AND "cancelled_by_user_id" IS NOT NULL
            AND "cancellation_reason" IS NOT NULL
            AND "cancellation_reason" <> ''
        )
        OR (
            "state" <> 'cancelled'
            AND "cancelled_by_user_id" IS NULL
            AND "cancellation_reason" IS NULL
        )
    );

ALTER TABLE "clinical_notes"
    ADD CONSTRAINT "clinical_notes_content_check" CHECK ("content" <> '');

ALTER TABLE "audit_records"
    ADD CONSTRAINT "audit_records_resource_check" CHECK (
        ("resource" = 'clinical_note' AND "appointment_id" IS NOT NULL)
        OR ("resource" = 'patient_contact' AND "appointment_id" IS NULL)
    );
