-- REG-5/REG-6: processo de TFD e transporte sanitário (frota, motoristas, rotas, viagens, passageiros, manutenção e abastecimento).
CREATE TYPE "TfdStatus" AS ENUM ('ABERTO', 'ENVIADO', 'DEFERIDO', 'INDEFERIDO', 'AGENDADO', 'CONCLUIDO', 'CANCELADO');
CREATE TYPE "VehicleKind" AS ENUM ('AMBULANCIA_BASICA', 'AMBULANCIA_UTI', 'VAN', 'MICRO_ONIBUS', 'ONIBUS', 'CARRO');
CREATE TYPE "TripStatus" AS ENUM ('PLANEJADA', 'EM_ANDAMENTO', 'CONCLUIDA', 'CANCELADA');
CREATE TYPE "PassengerStatus" AS ENUM ('AGENDADO', 'EMBARCOU', 'FALTOU', 'CANCELADO');
CREATE TYPE "VehicleLogKind" AS ENUM ('MANUTENCAO', 'ABASTECIMENTO');

CREATE TABLE "tfd_processes" (
  "id" UUID NOT NULL,
  "protocol" TEXT NOT NULL,
  "patient_id" UUID NOT NULL,
  "request_id" UUID,
  "unit_id" UUID NOT NULL,
  "requester_id" UUID NOT NULL,
  "requester_cbo" CHAR(6) NOT NULL,
  "cid" VARCHAR(5),
  "diagnosis" TEXT NOT NULL,
  "procedure_name" TEXT NOT NULL,
  "procedure_code" CHAR(10),
  "clinical_summary" TEXT NOT NULL,
  "justification" TEXT NOT NULL,
  "urgency" BOOLEAN NOT NULL DEFAULT false,
  "destination_city" TEXT NOT NULL,
  "destination_uf" CHAR(2) NOT NULL,
  "destination_ibge" TEXT,
  "destination_unit" TEXT,
  "transport" TEXT NOT NULL,
  "needs_companion" BOOLEAN NOT NULL DEFAULT false,
  "companion_name" TEXT,
  "companion_cpf" CHAR(11),
  "companion_relation" TEXT,
  "accommodation" BOOLEAN NOT NULL DEFAULT false,
  "status" "TfdStatus" NOT NULL DEFAULT 'ABERTO',
  "sent_at" TIMESTAMP(3),
  "opinion_at" TIMESTAMP(3),
  "opinion_by" UUID,
  "opinion_notes" TEXT,
  "allowance_approved" BOOLEAN NOT NULL DEFAULT false,
  "appointment_at" TIMESTAMP(3),
  "appointment_place" TEXT,
  "appointment_notes" TEXT,
  "allowance" JSONB NOT NULL DEFAULT '[]',
  "allowance_total" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "allowance_paid_at" TIMESTAMP(3),
  "trip_id" UUID,
  "closed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tfd_processes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tfd_processes_protocol_key" ON "tfd_processes"("protocol");
CREATE INDEX "tfd_processes_status_created_at_idx" ON "tfd_processes"("status", "created_at");
CREATE INDEX "tfd_processes_patient_id_idx" ON "tfd_processes"("patient_id");
CREATE INDEX "tfd_processes_unit_id_status_idx" ON "tfd_processes"("unit_id", "status");
ALTER TABLE "tfd_processes" ADD CONSTRAINT "tfd_processes_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "tfd_events" (
  "id" UUID NOT NULL,
  "process_id" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "from_status" "TfdStatus",
  "to_status" "TfdStatus",
  "user_id" UUID NOT NULL,
  "role" "Role" NOT NULL,
  "notes" TEXT,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tfd_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "tfd_events_process_id_at_idx" ON "tfd_events"("process_id", "at");
ALTER TABLE "tfd_events" ADD CONSTRAINT "tfd_events_process_id_fkey" FOREIGN KEY ("process_id") REFERENCES "tfd_processes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "vehicles" (
  "id" UUID NOT NULL,
  "plate" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "kind" "VehicleKind" NOT NULL,
  "seats" INTEGER NOT NULL,
  "wheelchair" BOOLEAN NOT NULL DEFAULT false,
  "odometer_km" INTEGER NOT NULL DEFAULT 0,
  "next_maintenance_km" INTEGER,
  "next_maintenance_at" DATE,
  "unit_id" UUID,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "vehicles_plate_key" ON "vehicles"("plate");

CREATE TABLE "drivers" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "cpf" CHAR(11),
  "phone" TEXT,
  "cnh" TEXT NOT NULL,
  "cnh_category" CHAR(2) NOT NULL,
  "cnh_expiry" DATE NOT NULL,
  "user_id" UUID,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "drivers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "transport_routes" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "destination_city" TEXT NOT NULL,
  "destination_uf" CHAR(2) NOT NULL,
  "stops" JSONB NOT NULL DEFAULT '[]',
  "weekdays" INTEGER[],
  "departure_time" CHAR(5) NOT NULL,
  "return_time" CHAR(5),
  "vehicle_id" UUID,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "transport_routes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "transport_trips" (
  "id" UUID NOT NULL,
  "route_id" UUID,
  "vehicle_id" UUID NOT NULL,
  "driver_id" UUID NOT NULL,
  "date" DATE NOT NULL,
  "departure_time" CHAR(5) NOT NULL,
  "destination_city" TEXT NOT NULL,
  "destination_uf" CHAR(2) NOT NULL,
  "destination_place" TEXT,
  "status" "TripStatus" NOT NULL DEFAULT 'PLANEJADA',
  "odometer_start" INTEGER,
  "odometer_end" INTEGER,
  "fuel_liters" DECIMAL(8,2),
  "fuel_cost" DECIMAL(10,2),
  "notes" TEXT,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "transport_trips_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "transport_trips_date_status_idx" ON "transport_trips"("date", "status");
CREATE INDEX "transport_trips_vehicle_id_date_idx" ON "transport_trips"("vehicle_id", "date");
ALTER TABLE "transport_trips" ADD CONSTRAINT "transport_trips_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "transport_routes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "transport_trips" ADD CONSTRAINT "transport_trips_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transport_trips" ADD CONSTRAINT "transport_trips_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "transport_passengers" (
  "id" UUID NOT NULL,
  "trip_id" UUID NOT NULL,
  "patient_id" UUID NOT NULL,
  "companion_name" TEXT,
  "pickup_address" TEXT,
  "appointment_at" TIMESTAMP(3),
  "appointment_place" TEXT,
  "wheelchair" BOOLEAN NOT NULL DEFAULT false,
  "tfd_id" UUID,
  "request_id" UUID,
  "status" "PassengerStatus" NOT NULL DEFAULT 'AGENDADO',
  "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "transport_passengers_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "transport_passengers_trip_id_idx" ON "transport_passengers"("trip_id");
CREATE INDEX "transport_passengers_patient_id_idx" ON "transport_passengers"("patient_id");
ALTER TABLE "transport_passengers" ADD CONSTRAINT "transport_passengers_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "transport_trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "transport_passengers" ADD CONSTRAINT "transport_passengers_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "vehicle_logs" (
  "id" UUID NOT NULL,
  "vehicle_id" UUID NOT NULL,
  "kind" "VehicleLogKind" NOT NULL,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "odometer_km" INTEGER NOT NULL,
  "cost" DECIMAL(10,2) NOT NULL,
  "liters" DECIMAL(8,2),
  "description" TEXT NOT NULL,
  "user_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vehicle_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "vehicle_logs_vehicle_id_at_idx" ON "vehicle_logs"("vehicle_id", "at");
ALTER TABLE "vehicle_logs" ADD CONSTRAINT "vehicle_logs_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
