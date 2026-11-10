-- A 0029 achatou as cadeias de unificação de cadastros seguindo até 50 saltos. Ela já foi aplicada assim nos bancos
-- publicados e não pode mudar (migração aplicada é imutável): esta segue a cadeia até o fim, qualquer que seja o
-- tamanho, e termina o que a 0029 deixou. Só dados (o esquema não muda) e idempotente: num banco sem cadeia, ou já
-- achatado, não muda nada.
--
-- Cada cadastro unificado passa a apontar para o fim da cadeia, o cadastro que não foi unificado em nenhum outro. O
-- caminho já percorrido (os ids) detecta o ciclo: a cadeia que volta a um cadastro dela não tem fim e fica como está,
-- e nenhum cadastro passa a apontar para si mesmo. Só mudam cadastros já unificados, que não aparecem nas buscas nem
-- vão ao e-SUS.
WITH RECURSIVE cadeia (id, destino, caminho) AS (
  -- Primeiro salto: o cadastro em que cada unificado foi unificado.
  SELECT p.id, p.merged_into_id, ARRAY[p.id] FROM patients p WHERE p.merged_into_id IS NOT NULL
  UNION ALL
  -- Salto seguinte, enquanto o destino também tiver sido unificado em outro e não estiver no caminho (ciclo).
  SELECT c.id, q.merged_into_id, c.caminho || q.id
  FROM cadeia c
  JOIN patients q ON q.id = c.destino
  WHERE q.merged_into_id IS NOT NULL AND q.id <> ALL (c.caminho)
),
-- O fim da cadeia: o destino que não foi unificado (um ciclo não tem fim).
fim AS (
  SELECT c.id, c.destino FROM cadeia c JOIN patients q ON q.id = c.destino WHERE q.merged_into_id IS NULL
)
UPDATE patients p
SET merged_into_id = f.destino
FROM fim f
WHERE p.id = f.id AND p.merged_into_id <> f.destino AND f.destino <> p.id;
