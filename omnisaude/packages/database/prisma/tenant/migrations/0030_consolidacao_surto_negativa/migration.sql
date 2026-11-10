-- VIG-1c (semana 27): consolidação das exportações oficiais (Sinan Net, Sinan Online, e-SUS Sinan e e-SUS Notifica)
-- com conciliação contra as notificações do OmniSaúde, população por território, diagrama de controle com canal
-- congelado por versão, plano de contingência com acionamento de estágio e checklist, notificação de surto (tipo 3,
-- sem paciente) com planilha de casos e linha do tempo, sugestões de surto dispensadas, unidades notificantes com
-- vigência e responsáveis, e o atesto da notificação negativa semanal. Só tipos novos: nenhum valor é acrescentado a
-- enum existente.

CREATE TYPE "OfficialImportStatus" AS ENUM ('PREVIA', 'APLICADA', 'DESCARTADA');
CREATE TYPE "OfficialRecordType" AS ENUM ('INDIVIDUAL', 'NEGATIVA', 'SURTO');
CREATE TYPE "RecordMatchMethod" AS ENUM ('NUMERO_OFICIAL', 'IDENTIDADE', 'MANUAL');
CREATE TYPE "TerritoryLevel" AS ENUM ('MUNICIPIO', 'LOCALIDADE', 'BAIRRO');
CREATE TYPE "PopulationSource" AS ENUM ('IBGE_DOU', 'RIPSA', 'CENSO_2022', 'MANUAL');
CREATE TYPE "ContingencyPlanStatus" AS ENUM ('RASCUNHO', 'VIGENTE', 'ARQUIVADO');
CREATE TYPE "OutbreakStatus" AS ENUM ('ABERTO', 'ENCERRADO', 'DESCARTADO');
CREATE TYPE "OutbreakCategory" AS ENUM ('SINDROMICO', 'FORA_DA_LISTA', 'DA_LISTA', 'DTA');
CREATE TYPE "NegativeReportStatus" AS ENUM ('ATESTADA', 'CANCELADA', 'ANULADA');

-- ───────────── Importação e conciliação ─────────────

-- Um envio (arquivo solto ou zip com vários arquivos). A prévia guarda os registros normalizados (JSON com gzip) em
-- payload, que é apagado ao aplicar, descartar ou expirar.
CREATE TABLE official_imports (
  id uuid PRIMARY KEY,
  system "OfficialSystem" NOT NULL,
  status "OfficialImportStatus" NOT NULL DEFAULT 'PREVIA',
  file_name text NOT NULL,
  sha256 char(64) NOT NULL,
  size_bytes integer NOT NULL,
  files jsonb NOT NULL DEFAULT '[]',
  period_from date,
  period_to date,
  declared_period boolean NOT NULL DEFAULT false,
  identified boolean NOT NULL DEFAULT false,
  counts jsonb NOT NULL DEFAULT '{}',
  preview jsonb,
  payload bytea,
  warnings jsonb NOT NULL DEFAULT '[]',
  created_by uuid NOT NULL,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  applied_by uuid,
  applied_at timestamp(3),
  discarded_by uuid,
  discarded_at timestamp(3)
);
CREATE INDEX official_imports_status_created_at_idx ON official_imports (status, created_at);
CREATE INDEX official_imports_sha256_idx ON official_imports (sha256);
-- O mesmo arquivo não é aplicado duas vezes.
CREATE UNIQUE INDEX official_imports_sha_aplicado ON official_imports (sha256) WHERE status = 'APLICADA';

-- Registro consolidado de um sistema oficial, pela chave natural do sistema.
CREATE TABLE official_records (
  id uuid PRIMARY KEY,
  system "OfficialSystem" NOT NULL,
  type "OfficialRecordType" NOT NULL,
  natural_key text NOT NULL,
  number varchar(20) NOT NULL,
  notified_on date NOT NULL,
  epi_week_notified char(6),
  municipality_ibge varchar(7),
  unit_cnes varchar(7),
  unit_id uuid REFERENCES units(id),
  agravo varchar(8),
  suspected_type varchar(2),
  group_key varchar(40),
  symptoms_onset date,
  epi_week_onset char(6),
  residence_ibge varchar(7),
  neighborhood_code varchar(20),
  neighborhood_name text,
  final_class varchar(2),
  criterion varchar(2),
  evolution varchar(2),
  closed_on date,
  death_on date,
  situation varchar(16) NOT NULL,
  severity varchar(16),
  -- Cancelado (e-SUS Notifica), excluída (e-SUS Sinan) ou NDUPLIC_N = 2 (duplicidade no Sinan).
  excluded boolean NOT NULL DEFAULT false,
  sensitive boolean NOT NULL DEFAULT false,
  patient_name text,
  patient_name_norm text,
  birth_date date,
  sex char(1),
  mother_name_norm text,
  cns varchar(15),
  cpf varchar(11),
  -- Extras normalizados e "_fontes" (campo -> tipo de arquivo que o gravou), para a mesclagem por campo.
  data jsonb NOT NULL DEFAULT '{}',
  content_hash char(64) NOT NULL,
  first_import_id uuid NOT NULL REFERENCES official_imports(id),
  last_import_id uuid NOT NULL REFERENCES official_imports(id),
  last_seen_at timestamp(3) NOT NULL,
  absent_since timestamp(3),
  notification_id uuid REFERENCES notifications(id),
  match_method "RecordMatchMethod",
  matched_by uuid,
  matched_at timestamp(3),
  divergences jsonb,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp(3) NOT NULL,
  CONSTRAINT official_records_situation CHECK (situation IN ('CONFIRMADO', 'DESCARTADO', 'INCONCLUSIVO', 'EM_INVESTIGACAO')),
  CONSTRAINT official_records_severity CHECK (severity IS NULL OR severity IN ('SINAIS_ALARME', 'GRAVE'))
);
CREATE UNIQUE INDEX official_records_system_type_natural_key_key ON official_records (system, type, natural_key);
-- Uma notificação do OmniSaúde casa com um registro oficial só.
CREATE UNIQUE INDEX official_records_notificacao ON official_records (notification_id) WHERE notification_id IS NOT NULL;
CREATE INDEX official_records_group_key_epi_week_onset_idx ON official_records (group_key, epi_week_onset);
CREATE INDEX official_records_unit_cnes_epi_week_notified_idx ON official_records (unit_cnes, epi_week_notified);
CREATE INDEX official_records_type_epi_week_notified_idx ON official_records (type, epi_week_notified);
CREATE INDEX official_records_cns_idx ON official_records (cns);
CREATE INDEX official_records_cpf_idx ON official_records (cpf);
CREATE INDEX official_records_patient_name_norm_birth_date_idx ON official_records (patient_name_norm, birth_date);

-- "Não é o mesmo caso": o par não é sugerido de novo.
CREATE TABLE official_record_rejections (
  id uuid PRIMARY KEY,
  record_id uuid NOT NULL REFERENCES official_records(id) ON DELETE CASCADE,
  notification_id uuid NOT NULL REFERENCES notifications(id),
  reason text NOT NULL,
  rejected_by uuid NOT NULL,
  rejected_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX official_record_rejections_record_id_notification_id_key ON official_record_rejections (record_id, notification_id);

-- ───────────── População e diagrama de controle ─────────────

-- Estimativa por ano, território, fonte e versão. O município não tem território (territory_id nulo); a localidade e o
-- bairro apontam para localities e neighborhoods (sem chave estrangeira: a tabela depende do nível).
CREATE TABLE population_estimates (
  id uuid PRIMARY KEY,
  year integer NOT NULL,
  level "TerritoryLevel" NOT NULL,
  territory_id uuid,
  population integer NOT NULL CHECK (population > 0),
  source "PopulationSource" NOT NULL,
  version varchar(20) NOT NULL DEFAULT '',
  notes text,
  created_by uuid,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp(3) NOT NULL,
  CONSTRAINT population_estimates_territorio CHECK ((level = 'MUNICIPIO') = (territory_id IS NULL))
);
CREATE UNIQUE INDEX population_estimates_chave ON population_estimates (year, level, COALESCE(territory_id, '00000000-0000-0000-0000-000000000000'::uuid), source, version);

-- Receita do canal por agravo (grupo do catálogo).
CREATE TABLE diagram_settings (
  group_key varchar(40) PRIMARY KEY,
  recipe jsonb NOT NULL,
  -- [{ano, motivo}]
  excluded_years jsonb NOT NULL DEFAULT '[]',
  population_source "PopulationSource",
  population_version varchar(20),
  updated_by uuid,
  updated_at timestamp(3) NOT NULL
);

-- Canal congelado por agravo, território e ano, com versão: só um ativo por vez.
CREATE TABLE control_channels (
  id uuid PRIMARY KEY,
  group_key varchar(40) NOT NULL,
  level "TerritoryLevel" NOT NULL,
  territory_id uuid,
  year integer NOT NULL,
  version integer NOT NULL,
  active boolean NOT NULL DEFAULT true,
  recipe jsonb NOT NULL,
  population_source "PopulationSource",
  population_version varchar(20),
  reference_years integer[] NOT NULL,
  -- SemanaCanal[] (52 posições).
  weeks jsonb NOT NULL,
  notes text,
  computed_by uuid NOT NULL,
  computed_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT control_channels_territorio CHECK ((level = 'MUNICIPIO') = (territory_id IS NULL))
);
CREATE UNIQUE INDEX control_channels_versao ON control_channels (group_key, level, COALESCE(territory_id, '00000000-0000-0000-0000-000000000000'::uuid), year, version);
CREATE UNIQUE INDEX control_channels_ativo ON control_channels (group_key, level, COALESCE(territory_id, '00000000-0000-0000-0000-000000000000'::uuid), year) WHERE active;

-- ───────────── Plano de contingência ─────────────

CREATE TABLE contingency_plans (
  id uuid PRIMARY KEY,
  scope varchar(40) NOT NULL DEFAULT 'ARBOVIROSES',
  name text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  status "ContingencyPlanStatus" NOT NULL DEFAULT 'RASCUNHO',
  valid_from date,
  valid_to date,
  source text,
  -- PlanoContingencia (estágios, critérios, ações e desmobilização).
  definition jsonb NOT NULL,
  created_by uuid,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by uuid,
  updated_at timestamp(3) NOT NULL
);
-- Um plano vigente por escopo.
CREATE UNIQUE INDEX contingency_plans_vigente ON contingency_plans (scope) WHERE status = 'VIGENTE';

-- Histórico de estágios acionados pela vigilância (vigências sem sobreposição: um aberto por território).
CREATE TABLE contingency_activations (
  id uuid PRIMARY KEY,
  plan_id uuid NOT NULL REFERENCES contingency_plans(id),
  level "TerritoryLevel" NOT NULL DEFAULT 'MUNICIPIO',
  territory_id uuid,
  stage varchar(30) NOT NULL,
  started_on date NOT NULL,
  started_week char(6) NOT NULL,
  ended_on date,
  ended_week char(6),
  justification text NOT NULL,
  act text,
  -- Retrato dos indicadores no acionamento.
  indicators jsonb NOT NULL,
  decided_by uuid NOT NULL,
  decided_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT contingency_activations_territorio CHECK ((level = 'MUNICIPIO') = (territory_id IS NULL))
);
CREATE UNIQUE INDEX contingency_activations_aberta ON contingency_activations (plan_id, level, COALESCE(territory_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE ended_on IS NULL;

-- Critério manual respondido pela vigilância na semana.
CREATE TABLE contingency_inputs (
  id uuid PRIMARY KEY,
  plan_id uuid NOT NULL REFERENCES contingency_plans(id),
  level "TerritoryLevel" NOT NULL DEFAULT 'MUNICIPIO',
  territory_id uuid,
  epi_week char(6) NOT NULL,
  criterion_id varchar(40) NOT NULL,
  met boolean NOT NULL,
  note text,
  answered_by uuid NOT NULL,
  answered_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT contingency_inputs_territorio CHECK ((level = 'MUNICIPIO') = (territory_id IS NULL))
);
CREATE UNIQUE INDEX contingency_inputs_chave ON contingency_inputs (plan_id, level, COALESCE(territory_id, '00000000-0000-0000-0000-000000000000'::uuid), epi_week, criterion_id);

-- Checklist de ações do acionamento (as do estágio e as dos anteriores: "manter e intensificar").
CREATE TABLE contingency_action_items (
  id uuid PRIMARY KEY,
  activation_id uuid NOT NULL REFERENCES contingency_activations(id) ON DELETE CASCADE,
  stage varchar(30) NOT NULL,
  axis varchar(30) NOT NULL,
  description text NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'PENDENTE',
  responsible text,
  note text,
  updated_by uuid,
  updated_at timestamp(3) NOT NULL,
  CONSTRAINT contingency_action_items_status CHECK (status IN ('PENDENTE', 'EM_ANDAMENTO', 'FEITA', 'NAO_SE_APLICA'))
);
CREATE INDEX contingency_action_items_activation_id_idx ON contingency_action_items (activation_id);

-- ───────────── Surto ─────────────

-- Notificação de surto (tipo 3 da ficha do Sinan Net), sem paciente. Numeração interna 'AAAA/NNNN' por ano.
CREATE TABLE outbreaks (
  id uuid PRIMARY KEY,
  year integer NOT NULL,
  seq integer NOT NULL,
  number varchar(12) NOT NULL,
  status "OutbreakStatus" NOT NULL DEFAULT 'ABERTO',
  category "OutbreakCategory" NOT NULL,
  group_key varchar(40),
  syndrome varchar(40),
  cid varchar(6),
  agent_text text,
  notified_on date NOT NULL,
  known_at timestamp(3) NOT NULL,
  due_at timestamp(3) NOT NULL,
  -- Emergência de saúde pública (item 22 da lista): também SES e MS em 24 h.
  esp boolean NOT NULL DEFAULT false,
  unit_id uuid NOT NULL REFERENCES units(id),
  notifier_id uuid NOT NULL,
  first_symptoms_on date NOT NULL,
  cases_count integer NOT NULL CHECK (cases_count >= 1),
  -- CS_LOCAL (1 a 11) e NM_LOCAL.
  initial_place varchar(2) NOT NULL,
  initial_place_text text,
  occurrence_ibge varchar(7),
  locality_id uuid,
  neighborhood_id uuid,
  address text,
  reference text,
  zone varchar(1),
  lat double precision,
  lng double precision,
  investigated_on date,
  -- CS_TRANS, TP_INDIRET (veículo codificado) e CS_VEICULO (texto do "outro").
  transmission varchar(1),
  vehicle varchar(1),
  vehicle_text varchar(50),
  observations text,
  investigator_name text,
  investigator_role text,
  -- Ficha de surto de DTA (campos 27 a 60), quando o veículo é alimento/água.
  dta jsonb,
  delimitation varchar(2),
  delimitation_text text,
  closed_on date,
  closing_notes text,
  closed_by uuid,
  discard_reason text,
  discarded_by uuid,
  discarded_at timestamp(3),
  official_number varchar(7),
  entered_by uuid,
  entered_at timestamp(3),
  -- Sugestão que originou o surto (assinatura, regra e casos).
  signal jsonb,
  created_by uuid NOT NULL,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp(3) NOT NULL
);
CREATE UNIQUE INDEX outbreaks_number_key ON outbreaks (number);
CREATE UNIQUE INDEX outbreaks_year_seq_key ON outbreaks (year, seq);
CREATE INDEX outbreaks_status_notified_on_idx ON outbreaks (status, notified_on);
CREATE INDEX outbreaks_unit_id_notified_on_idx ON outbreaks (unit_id, notified_on);

-- Planilha de acompanhamento do surto (uma linha por caso).
CREATE TABLE outbreak_cases (
  id uuid PRIMARY KEY,
  outbreak_id uuid NOT NULL REFERENCES outbreaks(id) ON DELETE CASCADE,
  case_number integer NOT NULL,
  notification_id uuid REFERENCES notifications(id),
  official_record_id uuid REFERENCES official_records(id),
  initials varchar(15),
  sex char(1),
  age_text varchar(10),
  residence_ibge varchar(7),
  neighborhood_id uuid,
  onset_on date,
  hospitalized boolean,
  died boolean,
  final_class varchar(1),
  criterion varchar(1),
  final_cid varchar(6),
  created_by uuid,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX outbreak_cases_outbreak_id_case_number_key ON outbreak_cases (outbreak_id, case_number);
-- A mesma notificação entra uma vez em cada surto.
CREATE UNIQUE INDEX outbreak_cases_notificacao ON outbreak_cases (outbreak_id, notification_id) WHERE notification_id IS NOT NULL;

-- Linha do tempo do surto (CRIADO, EDITADO, COMUNICADO, CASO_VINCULADO, CASO_RETIRADO, INVESTIGADO, ENCERRADO,
-- DESCARTADO, NUMERO_OFICIAL).
CREATE TABLE outbreak_events (
  id uuid PRIMARY KEY,
  outbreak_id uuid NOT NULL REFERENCES outbreaks(id) ON DELETE CASCADE,
  kind varchar(30) NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  by_user uuid,
  at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX outbreak_events_outbreak_id_at_idx ON outbreak_events (outbreak_id, at);

-- Sugestão de surto dispensada: vale enquanto não aparecer caso conhecido depois de until_known_at.
CREATE TABLE outbreak_dismissals (
  id uuid PRIMARY KEY,
  signature text NOT NULL,
  rule_id varchar(40),
  group_key varchar(40),
  link_kind varchar(20),
  link_id text,
  until_known_at timestamp(3) NOT NULL,
  reason text NOT NULL,
  dismissed_by uuid NOT NULL,
  dismissed_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX outbreak_dismissals_signature_idx ON outbreak_dismissals (signature);

-- ───────────── Notificação negativa ─────────────

-- Períodos em que a unidade é notificante (o denominador da negativa e da grade). Um período aberto por unidade.
CREATE TABLE notifying_units (
  id uuid PRIMARY KEY,
  unit_id uuid NOT NULL REFERENCES units(id),
  since date NOT NULL,
  until date,
  end_reason text,
  created_by uuid,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_by uuid,
  ended_at timestamp(3)
);
CREATE UNIQUE INDEX notifying_units_aberto ON notifying_units (unit_id) WHERE until IS NULL;
CREATE INDEX notifying_units_unit_id_since_idx ON notifying_units (unit_id, since);

-- Semeadura: toda unidade ativa que atende passa a ser notificante desde 01/01/2026 (fora a central de abastecimento
-- farmacêutico, o almoxarifado e a vigilância em saúde). A vigilância ajusta na tela das unidades notificantes.
INSERT INTO notifying_units (id, unit_id, since)
SELECT gen_random_uuid(), u.id, DATE '2026-01-01'
FROM units u
WHERE u.active AND u.type NOT IN ('FARMACIA_CENTRAL', 'ALMOXARIFADO', 'VIGILANCIA_SAUDE')
ORDER BY u.created_at, u.id;

-- Quem atesta a negativa da unidade (titular ou substituto).
CREATE TABLE notifying_unit_responsibles (
  id uuid PRIMARY KEY,
  unit_id uuid NOT NULL REFERENCES units(id),
  user_id uuid NOT NULL REFERENCES users(id),
  kind varchar(12) NOT NULL,
  since date NOT NULL,
  until date,
  designated_by uuid NOT NULL,
  designated_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_by uuid,
  revoked_at timestamp(3),
  CONSTRAINT notifying_unit_responsibles_kind CHECK (kind IN ('TITULAR', 'SUBSTITUTO'))
);
CREATE UNIQUE INDEX notifying_unit_responsibles_ativo ON notifying_unit_responsibles (unit_id, user_id) WHERE until IS NULL;
CREATE INDEX notifying_unit_responsibles_user_id_idx ON notifying_unit_responsibles (user_id);

-- Atesto da notificação negativa semanal. Cancelado quando aparece notificação, surto ou registro oficial da unidade na
-- semana (RQ003 do Sinan), com a causa gravada; anulado pela vigilância, com motivo.
CREATE TABLE negative_reports (
  id uuid PRIMARY KEY,
  unit_id uuid NOT NULL REFERENCES units(id),
  epi_week char(6) NOT NULL,
  status "NegativeReportStatus" NOT NULL DEFAULT 'ATESTADA',
  attested_by uuid NOT NULL,
  attested_at timestamp(3) NOT NULL,
  attester_name text NOT NULL,
  attester_role text,
  attester_cbo char(6),
  on_behalf boolean NOT NULL DEFAULT false,
  on_behalf_reason text,
  declaration text NOT NULL,
  late boolean NOT NULL DEFAULT false,
  cancelled_at timestamp(3),
  cancelled_by uuid,
  cancel_reason text,
  cause_notification_id uuid,
  cause_record_id uuid,
  cause_outbreak_id uuid,
  -- Negativa do Sinan (NNEGANET) casada com o atesto.
  official_record_id uuid REFERENCES official_records(id),
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX negative_reports_atestada ON negative_reports (unit_id, epi_week) WHERE status = 'ATESTADA';
CREATE INDEX negative_reports_epi_week_idx ON negative_reports (epi_week);
