# Agente de combate às endemias em campo e bloqueio de transmissão (VIG-3a)

Entrega da semana 26. O agente de combate às endemias (ACE) trabalha no celular sem internet: leva a zona, as
ordens de bloqueio que recebeu e o estoque de larvicida, registra cada visita ao imóvel (depósitos, focos, tubitos,
tratamento com baixa do larvicida por lote, nebulização, pendências) e sincroniza quando a rede volta, sem duplicar.
Cada notificação de dengue, chikungunya ou Zika abre ou amplia uma **ordem de bloqueio de transmissão**: casos da
mesma área e do mesmo período viram uma ordem só, sobre os quarteirões no raio de 150 m das residências. A visita
também vira a ficha de visita domiciliar e territorial do e-SUS APS.

## Base normativa e técnica (conferida em 06/11/2026)

| Tema | Regra adotada | Fonte |
|---|---|---|
| Bloqueio de transmissão | Ação imediata quando há notificação de caso suspeito; inspeção, eliminação de criadouros e controle larvário, com nebulização costal (UBV portátil) quando indicada | Diretrizes Nacionais para Prevenção e Controle das Arboviroses Urbanas (MS, 2025), § 7.1.4, p. 52 |
| Raio | No mínimo 150 m da residência do caso (cerca de nove quarteirões), começando pelo quarteirão de ocorrência; medido até a borda de cada quarteirão (semana 25) | Diretrizes de 2025, p. 52 e 84; Diretrizes de 2009, p. 83 |
| Agrupamento | Casos do mesmo período (até sete dias) e da mesma área numa ação só. Regra do sistema: residências a até duas vezes o raio (as áreas de 150 m se tocam) e datas a até 7 dias; o mesmo imóvel ou a mesma pessoa sempre caem na mesma ordem ativa | Diretrizes de 2025, p. 52 |
| Data do caso | Início dos sintomas; sem ele, a data em que a vigilância soube do caso | Ficha de notificação (Sinan) |
| Prazo para começar | O Ministério não fixa horas ("o mais rápido possível"); a SES-MG recomenda começar de 3 a 7 dias do início dos sintomas. O sistema marca a ordem aberta há mais de 3 dias sem campo (parâmetro local) | Diretrizes de 2025, p. 52 e 137; Nota Técnica nº 1/2025 e POP 02 da SES-MG |
| Epidemia | Com a transmissão espalhada, a ação passa a ser por área: a coordenação desliga a abertura automática | Diretrizes de 2025, cap. 9; Diretrizes de 2009, p. 83 |
| Depósitos | A1 e A2 (água para consumo), B (móveis), C (fixos), D1 (pneus), D2 (lixo, sucata, entulho), E (naturais). B e E não recebem larvicida; D2 só a sucata em ponto estratégico; A1, A2, C e D1 só como última alternativa | Manual do LIRAa (MS, 2013), Anexo C; Diretrizes de 2025, p. 38, 41 e 51 |
| Atividades | 1-LI, 2-LI+T, 3-PE, 4-T, 5-DF, 6-PVE e o bloqueio (boletim próprio); um boletim por atividade | Manual de Normas Técnicas do PNCD (FUNASA, 2001); instrutivo dos boletins de campo (SES-RS) |
| Pendência | Fechado e recusado (F e R do boletim); abandonado é o imóvel em evidente desuso | Boletins do PNCD; Lei 13.301/2016, art. 1º, § 2º |
| Tubitos | Um por depósito com foco, nunca misturado; cada agente numera de 1 a 999 e recomeça | Manual do LIRAa, 2013; FUNASA, 2001 |
| Larvicidas | Rotina: Bti WG 37,4% (em gramas) e disco de piriproxifeno 2% para recipientes de 40 a 500 L; fornecidos pelo Ministério (pedido pelo SIES); validade de lotes pode ser prorrogada por nota técnica | Nota Informativa nº 29/2024-CGARB (e NI 10/2025); Nota Técnica nº 54/2025-CGARB |
| Dose | Pela capacidade total do depósito (cubagem), conforme a nota técnica do produto: o sistema registra a quantidade usada, sem calcular a dose | Diretrizes de 2025, p. 51 |
| Índices | IIP = imóveis com foco ÷ imóveis inspecionados × 100; Breteau = depósitos com foco ÷ imóveis inspecionados × 100; IR = depósitos com foco ÷ depósitos inspecionados × 100; ITR = depósitos com foco do tipo ÷ total com foco × 100. IIP abaixo de 1% satisfatório, de 1% a 3,9% alerta, 4% ou mais risco | Manual do LIRAa, 2013, p. 19-20; Diretrizes de 2009, p. 75; Nota Informativa nº 11/2026 |
| Pendência aceitável | Abaixo de 10% (meta); acima de 20% a área é sinalizada | PNCD (FUNASA, 2002), p. 7; Diretrizes de 2009, p. 141 |
| Supervisão e carga | 1 supervisor de campo para 10 ACE; 800 a 1.000 imóveis por agente, em ciclos bimestrais | Diretrizes de 2025, p. 90; Diretrizes de 2009, p. 61 e 63 |
| ACE | Atribuições (controle químico e biológico, cadastro e atualização da base de imóveis, registro conforme as normas do SUS) e supervisão pelo gestor | Lei 11.350/2006, art. 4º, com a redação da Lei 13.595/2018 |
| CBO | 5151-40 Agente de combate às endemias (definitivo; substituiu o provisório 5151-F1); não há CBO próprio de supervisor de endemias | Portaria GM/MS 535/2016; Diretriz Nacional para Atuação Integrada dos ACE e ACS (MS, 2025), p. 15 |
| Ficha do e-SUS | Ficha de visita domiciliar e territorial (tipo 8) aceita o CBO 515140; motivos do controle ambiental e vetorial: 34 ação educativa, 35 imóvel com foco, 36 ação mecânica, 37 tratamento focal; recusada ou ausente vai sem motivo; imóvel que não é domicílio vai sem dado de pessoa; CPF ou CNS, não os dois; no domicílio, o responsável familiar | LEDI do e-SUS APS 8.7.0 (dicionário da FVD e tabela 7 de CBO) |
| Imóvel fechado ou recusado | O ingresso forçado da Lei 13.301/2016 só vale com emergência em saúde pública declarada (ESPIN) e exige "ausência" documentada (duas visitas comunicadas, em dias e períodos alternados, em até 10 dias); fora dela vale o código de posturas do município | Lei 13.301/2016, arts. 1º a 3º; Amparo legal à execução das ações de campo (MS, 2006); Diretrizes de 2025, Apêndice G |
| Sigilo | O agente e a supervisão não veem nome, endereço, ponto nem agravo do caso: só os quarteirões, com o de ocorrência marcado | Lei 6.259/1975, art. 10 (redação da Lei 14.289/2022); LGPD, art. 6º, III |

O e-SUS APS não tem campo para depósitos, focos, larvicida nem bloqueio (só os motivos 34 a 37): o boletim
detalhado fica no OmniSaúde; o SisPNCD e os sistemas estaduais não têm interface pública de integração.

## O que foi entregue

### Papéis e permissões

| Papel | Quem | Pode |
|---|---|---|
| Agente de combate às endemias (`ACE`) | CBO 515140 (a importação do CNES sugere este papel) | App de campo: pacote da zona e das ordens designadas, visitas, imóvel novo, posição do imóvel nos seus quarteirões. **Não lê prontuário** |
| Supervisor de campo (`SUPERVISOR_ENDEMIAS`) | ACE designado para a supervisão (CBO 515140 na demonstração) | Zonas, ordens (designar agentes, concluir, reabrir, recalcular), visitas, pendências, resolver baixas de larvicida; também usa o app de campo |
| Coordenação de endemias (`COORDENADOR_ENDEMIAS`) | Técnico responsável | Tudo da supervisão, mais configuração do bloqueio, cancelamento de ordem, cadastro de insumo, entrada por remessa e prorrogação de validade; edita o território |
| Vigilância epidemiológica e gestão | | Acompanham as ordens, zonas, visitas e a produção (`endemias.ler`); a ficha da notificação mostra a ordem do caso |

### Modelo de dados (migração `0027_endemias`)

- `vector_zones` e `vector_zone_blocks`: zona de trabalho do ACE (um quarteirão fica numa zona só).
- `vector_visits`: visita ao imóvel com atividade, situação, recuperação, ciclo bimestral, contagens por tipo de
  depósito, tubitos, nebulização, ação educativa e GPS; `client_id` único (idempotência do aparelho).
- `vector_treatments`: produto, lote, quantidade e depósitos de cada tratamento, com a situação da baixa
  (`BAIXADO`, `PENDENTE`, `REGULARIZADO`, `CANCELADO`) e o motivo da pendência; índice único no movimento de estoque
  (uma baixa e um ajuste por linha, mesmo com reenvio simultâneo).
- `vector_stock_receipts`: entrada por remessa (guia do SIES ou da SES), uma por documento e lote.
- `blocking_orders`, `blocking_order_cases`, `blocking_order_blocks`, `blocking_order_assignees`: a ordem, as
  notificações ligadas (uma ordem por notificação), os quarteirões no raio e os agentes designados.
- Novos valores: papéis `ACE`, `SUPERVISOR_ENDEMIAS`, `COORDENADOR_ENDEMIAS`; local de estoque `ENDEMIAS`;
  movimentos `TRATAMENTO_FOCAL` e `ENTRADA_REMESSA`; produto marcado como larvicida ou adulticida (não sai na
  dispensação da farmácia).

### Ordem de bloqueio

- **Abertura**: cada criação ou mudança de notificação dos grupos configurados (padrão: dengue, chikungunya e Zika;
  febre amarela é opção local) é avaliada depois do commit. Anomalia congênita, caso descartado (ou encerrado como
  descartado), residência fora do município e caso com início dos sintomas há mais de 30 dias não abrem ordem.
- **Uma ordem para casos próximos**: a notificação entra na ordem ativa mais antiga que tenha um caso a até duas vezes
  o raio e a até 7 dias (ou do mesmo imóvel ou pessoa); senão, abre uma ordem nova, numerada no ano (`1/2026`). Uma
  trava no banco serializa as decisões: duas notificações simultâneas não abrem duas ordens.
- **Quarteirões**: a união dos quarteirões a até 150 m (até a borda) de cada residência ativa. Antes do trabalho de
  campo a lista acompanha os casos; depois de começar, só cresce. Os titulares das zonas atingidas são designados
  sozinhos; a supervisão ajusta.
- **Residência sem posição boa** (rua sem número, centro do bairro, CEP): a ordem fica "aguardando a localização"
  até a vigilância marcar o imóvel (ou o GPS de uma visita do ACS); localizado perto de outra ordem ativa, o caso
  passa para ela e a ordem vazia é cancelada como unificada. Face de quadra e centro do quarteirão entram com aviso
  "conferir o imóvel".
- **Caso descartado** sai da ordem; ordem sem caso e sem visita é cancelada; com visita, fica para a supervisão
  decidir.
- **Situação**: aguardando localização, aberta, em campo (na primeira visita sincronizada), concluída (com
  justificativa se ficou imóvel sem visita ou pendente) ou cancelada (só a coordenação). Concluída pode ser reaberta.
- **Varredura a cada 5 minutos**: refaz o que o gatilho não conseguiu (trava ocupada, falha), religa notificação
  reaberta, desliga caso descartado, recalcula a posição dos casos que aguardam e a lista da ordem sem quarteirão (a
  malha chegou depois).
- **Configuração** (coordenação): abertura automática, janela de agrupamento, agravos e alerta de ordem sem início.

### App de campo do ACE (`/campo-ace`, sem internet)

- **Pacote**: zona (quarteirões e imóveis com a situação no ciclo bimestral), ordens designadas (quarteirões com o
  de ocorrência marcado e os imóveis já trabalhados nelas) e lotes de larvicida com saldo no depósito de endemias da
  unidade, guardados no aparelho. Sem o ponto nem o agravo do caso.
- **Visita**: atividade (LI+T, LI, T, bloqueio, PE, DF, PVE), data e hora, situação (trabalhado, fechado,
  recusado, abandonado), tabela de depósitos A1 a E (inspecionados, com foco, eliminados, tratados), tubitos
  numerados, larvicida (produto, lote, quantidade, depósitos) com o saldo estimado, nebulização intra ou
  peridomiciliar no bloqueio, ação educativa, GPS e observação. As mesmas regras da API conferem a visita antes de ela
  entrar na fila (tubito sem foco, depósito B tratado, tratados que não batem com os produtos...).
- **Imóvel novo** no quarteirão (tipo, sequência, endereço, GPS opcional): pode ser visitado antes de sincronizar.
- **Fila no aparelho** (IndexedDB), presa ao usuário: outro usuário no mesmo aparelho não envia o trabalho alheio.
  Queda de rede, sessão vencida e erro do servidor deixam o registro pendente; só a recusa da operação vira erro, com
  a mensagem, para tentar de novo ou descartar.
- **Sincronização idempotente**: a visita (ou o imóvel), o registro do `clientId` e a baixa do estoque vão numa
  transação só; o reenvio, em sequência ou simultâneo (resposta perdida, duas abas), volta como "já estava no
  servidor".
- **Recuperação**: retorno a imóvel pendente no mesmo ciclo (ou na mesma ordem) fica marcado.
- **Posição**: o GPS da visita (até 50 m) posiciona o imóvel sem posição boa, nos quarteirões do agente, sem mexer no
  cadastro do e-SUS.

### Larvicida por lote

- A baixa sai do depósito de endemias da unidade do agente, no lote informado. Sem saldo, com lote desconhecido ou de
  outro produto, a visita é gravada e a baixa fica **pendente** (o larvicida já foi usado); lote vencido na data da
  visita é baixado e marcado.
- A supervisão resolve cada pendência: baixar em outro lote, regularizar (ajuste só da diferença e a baixa, para o
  estoque físico que existia) ou cancelar (registro errado).
- A coordenação cadastra o insumo, lança a remessa (guia do SIES ou da SES, sem nota fiscal; a mesma guia não entra
  duas vezes para o lote) e prorroga a validade de um lote por nota técnica (auditado).

### Telas da supervisão (`/endemias`)

Bloqueios (lista com cobertura e pendência, ordem com mapa dos quarteirões e progresso por quarteirão, agentes e
ações), Zonas (montar com os quarteirões livres e designar o titular), Visitas (boletins do período), Pendências
(imóveis com as tentativas e a "ausência" documentada; baixas de larvicida), Larvicidas (saldo por lote, uso em 30
dias, remessa, prorrogação), Produção e índices (por agente e localidade, IIP, Breteau, IR, ITR) e Configuração.
A ficha da notificação ganhou o cartão da ordem de bloqueio do caso (as arboviroses); os demais agravos mantêm o
cartão dos quarteirões no raio.

### Ficha do e-SUS APS

A visita do ACE gera a ficha de visita domiciliar e territorial (tipo 8) no lote da unidade do agente, uma por
agente, CBO e dia: motivos 34 a 37 pelo trabalho feito (28 quando só houve inspeção), desfecho pela situação
(fechado e abandonado como ausente), tipo de imóvel, microárea do imóvel ou fora de área, posição, e no domicílio o
responsável familiar. A ficha de visita em geral passou a seguir as regras do LEDI 8.7.0 que faltavam: recusada ou
ausente sem motivo nem medição, imóvel que não é domicílio sem pessoa e só com os motivos aceitos, CPF ou CNS (não os
dois), tipo de glicemia nos códigos do LEDI, CASAI e coordenadas com 6 casas; o CBO da ficha passou a ser o da visita.

## Demonstração

A carga de desenvolvimento (`node packages/database/dist/cli.js seed`) cria a malha da sede (36 quarteirões sobre os
domicílios de exemplo, mais comércio, terreno baldio, borracharia e escola), a zona 01 do ACE e o depósito de
endemias com Bti WG e disco de piriproxifeno. Senha `OmniSaude2026`, instituição `demo`:

| Papel | CPF |
|---|---|
| Agente de combate às endemias | 100.000.016-86 |
| Supervisora de campo | 100.000.017-67 |
| Coordenador de endemias | 100.000.018-48 |

Notifique dengue para dois vizinhos (ex.: José Carlos Pereira e Pedro Henrique Alves, como médica): a vigilância vê
a ordem 1 na ficha, a supervisora acompanha em Endemias e o ACE a encontra em Campo do ACE > Bloqueios.

## Como foi verificado

- Regras compartilhadas (`packages/shared/test/endemias.test.ts`): conferência da visita, motivos do e-SUS, ciclo,
  índices, agrupamento por área e janela, CBO 515140 e permissões do ACE.
- Ficha do e-SUS (`packages/esus/test/fichas.test.ts`): ACE sem equipe, ponto estratégico sem pessoa, domicílio com o
  CPF do responsável, fechado e recusado sem motivo, CASAI; o validador recusa motivo em visita ausente, CPF com CNS
  e pessoa fora do domicílio.
- API contra PostgreSQL real (`apps/api/test/endemias.test.ts`): **duas notificações próximas geram uma única ordem**
  com a união dos quarteirões; longe ou fora da janela, outra ordem; notificações simultâneas, uma ordem só; caso
  descartado cancela a ordem sem campo; residência localizada depois une as ordens; **o ACE trabalha sem rede e nada
  duplica ao sincronizar** (reenvio em sequência e simultâneo, uma baixa só); baixa sem saldo pendente e regularizada;
  remessa sem duplicar a guia; conclusão justificada; produção e índices; fichas do e-SUS válidas; abertura
  automática desligada.
- No navegador: ver `docs/STATUS.md` (Verificação feita).

## Pontos de atenção e fora do escopo

- Os insumos e o estoque físico de larvicida, os ACE no CNES, as zonas, a malha e o código de posturas são da
  instituição (`docs/PENDENCIAS.md`).
- O adulticida da nebulização não tem baixa por imóvel (o consumo é por carga da bomba): fica registrado onde houve
  nebulização; o controle do adulticida e os ciclos de UBV com intervalo entram com o laboratório (semana 28) ou
  depois.
- O índice é preliminar: "com foco" é a larva ou pupa vista em campo; a espécie (Aedes aegypti ou albopictus) vem do
  laboratório de entomologia (semana 28), que recebe os tubitos já numerados.
- Pontos estratégicos e imóveis especiais com periodicidade por risco, ovitrampas e LIRAa/LIA ficam para as semanas 28
  e para a Onda 4b; o bloqueio a partir do local provável de infecção (trabalho, escola) não é automático.
- O lote do e-SUS continua por período, como nas demais fichas: visita sincronizada depois de enviado o lote do
  período entra no lote seguinte que cobrir a data dela.
- A carga de estoque física por agente (o ACE levar uma quantidade do depósito) ainda não existe: a baixa é no
  depósito da unidade.
