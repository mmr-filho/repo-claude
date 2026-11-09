-- Semana 26, quinta rodada: dados gravados antes de duas regras desta semana. Só dados (o esquema não muda), e rodar
-- de novo não muda nada: a segunda rodada não acha mais o que corrigir.

-- O início do campo (started_at) é a única âncora de tempo da ordem em campo e nunca fica antes da abertura
-- (opened_at). A ordem gravada antes dessa regra com o início antes da abertura (a primeira visita feita com o relógio
-- do aparelho atrasado) passa a começar na abertura. A ordem que ainda não foi a campo (sem início) fica como está.
UPDATE blocking_orders SET started_at = opened_at WHERE started_at < opened_at;

-- Cadeias de unificação de cadastros (x unificado em d, depois d unificado em s): os joins do bloqueio, a varredura e
-- o redirecionamento do cadastro seguem um salto só, e o caso de x ficava sem o domicílio de s. A unificação agora
-- repõe no que fica os cadastros já unificados no duplicado; aqui, cada cadastro unificado passa a apontar para o fim
-- da cadeia, o cadastro que não foi unificado em nenhum outro. A cadeia é seguida até 50 saltos (contra ciclo): a que
-- não chega ao fim fica como está, e nenhum cadastro passa a apontar para si mesmo. Só mudam cadastros já unificados,
-- que não aparecem nas buscas nem vão ao e-SUS.
WITH RECURSIVE cadeia (id, destino, saltos) AS (
  -- Primeiro salto: o cadastro em que cada unificado foi unificado.
  SELECT p.id, p.merged_into_id, 1 FROM patients p WHERE p.merged_into_id IS NOT NULL
  UNION ALL
  -- Salto seguinte, enquanto o destino também tiver sido unificado em outro.
  SELECT c.id, q.merged_into_id, c.saltos + 1
  FROM cadeia c
  JOIN patients q ON q.id = c.destino
  WHERE q.merged_into_id IS NOT NULL AND c.saltos < 50
),
-- O fim da cadeia: o destino que não foi unificado (um ciclo não tem fim).
fim AS (
  SELECT c.id, c.destino FROM cadeia c JOIN patients q ON q.id = c.destino WHERE q.merged_into_id IS NULL
)
UPDATE patients p
SET merged_into_id = f.destino
FROM fim f
WHERE p.id = f.id AND p.merged_into_id <> f.destino AND f.destino <> p.id;
