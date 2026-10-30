-- ─────────────────────────────────────────────────────────────────────────────
-- Trilha de auditoria imutável e proteção de registros clínicos assinados
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION omni_audit_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'A trilha de auditoria é imutável (% bloqueado)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_entries_immutable
  BEFORE UPDATE OR DELETE ON audit_entries
  FOR EACH ROW EXECUTE FUNCTION omni_audit_immutable();

CREATE TRIGGER audit_entries_no_truncate
  BEFORE TRUNCATE ON audit_entries
  FOR EACH STATEMENT EXECUTE FUNCTION omni_audit_immutable();

CREATE OR REPLACE FUNCTION omni_signed_note_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'ASSINADO' THEN
    RAISE EXCEPTION 'Registro clínico assinado não pode ser alterado; registre uma nova evolução';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER clinical_notes_signed_immutable
  BEFORE UPDATE OR DELETE ON clinical_notes
  FOR EACH ROW EXECUTE FUNCTION omni_signed_note_immutable();

-- ─────────────────────────────────────────────────────────────────────────────
-- Camada analítica (BI e Text-to-SQL)
-- Só estas views ficam visíveis ao papel omni_bi, usado na réplica de leitura.
-- Nomes em português para casar com as perguntas dos gestores. Sem CPF, telefone ou endereço.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS bi;

CREATE VIEW bi.unidades AS
SELECT u.id, u.cnes, u.name AS nome, u.type::text AS tipo, u.ibge_code AS municipio_ibge, u.active AS ativa
FROM units u;

COMMENT ON VIEW bi.unidades IS 'Unidades da rede (UBS, UPA, hospital, farmácia central...).';

CREATE VIEW bi.pacientes AS
SELECT
  p.id,
  p.name AS nome,
  p.cns,
  p.sex::text AS sexo,
  p.birth_date AS data_nascimento,
  date_part('year', age(p.birth_date))::int AS idade,
  p.raca_cor,
  p.ibge_code AS municipio_ibge,
  p.district AS bairro,
  EXISTS (SELECT 1 FROM patient_conditions c WHERE c.patient_id = p.id AND c.active AND c.line_of_care = 'HIPERTENSAO') AS hipertenso,
  EXISTS (SELECT 1 FROM patient_conditions c WHERE c.patient_id = p.id AND c.active AND c.line_of_care = 'DIABETES') AS diabetico,
  EXISTS (SELECT 1 FROM patient_conditions c WHERE c.patient_id = p.id AND c.active AND c.line_of_care = 'GESTANTE') AS gestante,
  EXISTS (SELECT 1 FROM patient_conditions c WHERE c.patient_id = p.id AND c.active AND c.line_of_care = 'ONCOLOGIA') AS oncologico,
  p.deceased_at IS NOT NULL AS falecido,
  p.created_at AS cadastrado_em
FROM patients p;

COMMENT ON VIEW bi.pacientes IS 'Pacientes do tenant com idade calculada e marcadores de linhas de cuidado.';

CREATE VIEW bi.condicoes AS
SELECT c.id, c.patient_id AS paciente_id, c.system::text AS sistema, c.code AS codigo, c.description AS descricao,
       c.line_of_care::text AS linha_cuidado, c.onset_at AS inicio, c.active AS ativa
FROM patient_conditions c;

CREATE VIEW bi.atendimentos AS
SELECT
  e.id,
  e.patient_id AS paciente_id,
  e.unit_id AS unidade_id,
  u.name AS unidade,
  u.type::text AS tipo_unidade,
  e.kind::text AS tipo,
  e.status::text AS situacao,
  e.responsible_id AS profissional_id,
  us.name AS profissional,
  e.main_cid AS cid_principal,
  e.outcome::text AS desfecho,
  e.started_at AS inicio,
  e.ended_at AS fim,
  (extract(epoch FROM (e.ended_at - e.started_at)) / 60)::int AS duracao_min,
  EXISTS (SELECT 1 FROM clinical_notes n WHERE n.encounter_id = e.id AND n.role = 'MEDICO') AS consulta_medica,
  (SELECT t.risk_color::text FROM triages t WHERE t.encounter_id = e.id ORDER BY t.classified_at DESC LIMIT 1) AS cor_risco
FROM encounters e
JOIN units u ON u.id = e.unit_id
LEFT JOIN users us ON us.id = e.responsible_id;

COMMENT ON VIEW bi.atendimentos IS 'Atendimentos (consultas, urgência, internação). consulta_medica = houve registro de médico.';

CREATE VIEW bi.classificacoes_risco AS
SELECT t.id, t.encounter_id AS atendimento_id, e.unit_id AS unidade_id, u.name AS unidade,
       t.risk_color::text AS cor, t.suggested_color::text AS cor_sugerida, t.pain_score AS escala_dor,
       t.classified_at AS classificado_em, e.started_at AS chegada
FROM triages t
JOIN encounters e ON e.id = t.encounter_id
JOIN units u ON u.id = e.unit_id;

CREATE VIEW bi.agendamentos AS
SELECT a.id, a.patient_id AS paciente_id, a.unit_id AS unidade_id, u.name AS unidade, s.name AS agenda, s.cbo,
       us.name AS profissional, a.starts_at AS data_hora, a.kind::text AS tipo, a.status::text AS situacao,
       a.confirmation_channel AS canal_confirmacao
FROM appointments a
JOIN schedules s ON s.id = a.schedule_id
JOIN units u ON u.id = a.unit_id
JOIN users us ON us.id = a.professional_id;

CREATE VIEW bi.dispensacoes AS
SELECT d.id, di.id AS item_id, d.patient_id AS paciente_id, d.unit_id AS unidade_id, u.name AS unidade,
       sl.name AS local_estoque, pr.description AS produto, pr.active_ingredient AS principio_ativo, pr.catmat,
       di.quantity AS quantidade, d.dispensed_at AS data_dispensacao, d.controlled AS controlado
FROM dispensations d
JOIN dispensation_items di ON di.dispensation_id = d.id
JOIN products pr ON pr.id = di.product_id
JOIN units u ON u.id = d.unit_id
JOIN stock_locations sl ON sl.id = d.location_id;

COMMENT ON VIEW bi.dispensacoes IS 'Medicamentos entregues ao cidadão (um registro por item dispensado).';

CREATE VIEW bi.prescricoes AS
SELECT p.id, pi.id AS item_id, p.patient_id AS paciente_id, p.prescriber_id AS prescritor_id, p.signed_at AS data,
       pi.description AS item, pi.active_ingredient AS principio_ativo, p.status::text AS situacao
FROM prescriptions p
JOIN prescription_items pi ON pi.prescription_id = p.id;

CREATE VIEW bi.exames AS
SELECT x.id, x.patient_id AS paciente_id, x.sigtap_code AS procedimento, x.name AS exame, x.analyte AS analito,
       x.status::text AS situacao, x.requested_at AS data_solicitacao, x.result_at AS data_resultado,
       x.result_value AS resultado, x.result_unit AS unidade_medida
FROM exam_requests x;

CREATE VIEW bi.estoque AS
SELECT u.name AS unidade, sl.name AS local_estoque, sl.kind::text AS tipo_local, pr.description AS produto,
       pr.active_ingredient AS principio_ativo, pr.catmat, l.lot_number AS lote, l.expiry AS validade, sb.quantity AS quantidade
FROM stock_balances sb
JOIN stock_locations sl ON sl.id = sb.location_id
JOIN units u ON u.id = sl.unit_id
JOIN stock_lots l ON l.id = sb.lot_id
JOIN products pr ON pr.id = l.product_id;

CREATE VIEW bi.leitos AS
SELECT b.id, u.name AS unidade, w.name AS setor, w.kind::text AS tipo_setor, b.code AS leito,
       b.status::text AS situacao, b.isolation::text AS isolamento
FROM beds b
JOIN wards w ON w.id = b.ward_id
JOIN units u ON u.id = w.unit_id;

CREATE VIEW bi.internacoes AS
SELECT a.id, a.patient_id AS paciente_id, u.name AS unidade, w.name AS setor, a.main_cid AS cid_principal,
       a.admitted_at AS data_internacao, a.discharged_at AS data_alta,
       date_part('day', coalesce(a.discharged_at, now()) - a.admitted_at)::int AS dias_internacao
FROM admissions a
JOIN encounters e ON e.id = a.encounter_id
JOIN units u ON u.id = e.unit_id
LEFT JOIN beds b ON b.id = a.bed_id
LEFT JOIN wards w ON w.id = b.ward_id;

CREATE VIEW bi.producao AS
SELECT pr.id, pr.competencia, pr.unit_id AS unidade_id, u.name AS unidade, pr.procedure_code AS procedimento,
       sp.name AS procedimento_nome, pr.cbo, pr.cid, pr.quantity AS quantidade, pr.instrument::text AS instrumento,
       pr.status::text AS situacao, pr.performed_at AS data_realizacao
FROM production_records pr
JOIN units u ON u.id = pr.unit_id
LEFT JOIN sigtap_procedures sp ON sp.code = pr.procedure_code;

CREATE VIEW bi.busca_ativa AS
SELECT c.id, c.patient_id AS paciente_id, c.line_of_care::text AS linha_cuidado, c.status::text AS situacao,
       c.last_visit_at AS ultima_consulta, c.opened_at AS aberto_em, c.closed_at AS encerrado_em,
       (SELECT count(*) FROM active_search_contacts k WHERE k.case_id = c.id)::int AS contatos
FROM active_search_cases c;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_bi') THEN
    CREATE ROLE omni_bi NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA bi TO omni_bi;
GRANT SELECT ON ALL TABLES IN SCHEMA bi TO omni_bi;
