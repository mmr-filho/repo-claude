# Vigilância em saúde: notificação compulsória (VIG-1a e VIG-1b)

Entregas das semanas 23 (notificação a partir do atendimento) e 24 (investigação, encerramento, saída para os
sistemas oficiais, REL de covid-19 e mpox e comunicação policial; seção [Semana 24](#semana-24-vig-1b--int-4a)).

## Base normativa (conferida em 01/11/2026)

| Tema | Regra | Fonte |
|---|---|---|
| Lista de agravos | Anexo 1 do Anexo V da Portaria de Consolidação GM/MS nº 4/2017, na redação da **PRT GM/MS nº 11.211, de 13/05/2026** (DOU de 14/05/2026, ed. 89, seção 1, p. 1120): 66 itens em 81 linhas. A redação anterior (PRT GM/MS nº 10.175/2026, 77 linhas) vale para fatos de 26/01 a 13/05/2026 | compilado oficial da PRC 4/2017 na BVS |
| Quem notifica | quem atende (médicos, outros profissionais de saúde e responsáveis pelos estabelecimentos), na suspeita ou na confirmação | art. 3º do Anexo V |
| Imediata | em até 24 horas do primeiro atendimento, pelo meio mais rápido disponível, às esferas marcadas na lista (MS, SES, SMS) | art. 2º, VII, e art. 4º |
| Semanal | em até 7 dias do conhecimento da ocorrência | art. 2º, VIII |
| Repasse | a autoridade que recebe repassa às demais esferas em até 24 horas | art. 4º, parágrafo único |
| Sigilo | identificação do paciente com sigilo | art. 7º |
| Semana epidemiológica | de domingo a sábado; a semana 1 é a que contém o dia 4 de janeiro | calendário do Sinan |

Não existe API de escrita no Sinan Net, no e-SUS Sinan, no e-SUS Notifica nem no Sivep-Gripe: o registro nos
sistemas oficiais segue por digitação (fila da semana 24). A RNDS só recebe resultado de exame (REL) de covid-19 e
mpox, também na semana 24.

## Catálogo da lista (LNNC)

- **Gerado do texto oficial**: `scripts/vigilancia/extrair_lnnc.py` lê a tabela do Anexo 1 no HTML compilado da
  BVS (células com `rowspan`/`colspan` resolvidas) e `scripts/vigilancia/gerar_catalogo.py` grava
  `packages/shared/src/vigilancia/lnnc-nacional.ts`. As marcas MS, SES, SMS e Semanal vêm célula por célula do
  texto; o script só acrescenta a curadoria: chave estável, grupo, contexto (caso, óbito, gestante, anomalia
  congênita), critério (suspeita ou confirmação), marco do prazo, sigilo, notificação única por pessoa e notas.
  Teste: 81 linhas e 66 itens na redação vigente, 77 na anterior, e a conferência de linhas sensíveis.
- **No banco**: na primeira vez em cada instituição, as duas versões nacionais, o de-para inicial e o contato do
  CIEVS Nacional (0800-644-6645, notifica@saude.gov.br) são gravados. Quando a curadoria do catálogo gerado muda
  (hash do conteúdo), as linhas nacionais são atualizadas por chave e as que saíram ficam inativas. A vigilância
  municipal cadastra **listas estaduais ou municipais** (ato, vigência, sem sobreposição no mesmo escopo), que só
  **acrescentam** agravos: uma linha local não pode usar a chave nem o grupo de um agravo nacional (não afrouxa
  prazo nem sigilo da regra federal).
- **Versão pela data**: a notificação usa a lista vigente na data do primeiro atendimento (um atendimento de
  10/05/2026 usa a PRT 10.175/2026).
- **Notas normativas**:
  - Caxumba (item 48): o art. 2º, I, fala em notificação imediata, mas o Anexo 1 marca semanal; seguimos o anexo,
    com a linha marcada "em revisão normativa".
  - Síndrome gripal por covid-19 (item 60): notifica-se o caso **confirmado**; o prazo conta da confirmação
    (a ficha mostra "aguardando confirmação" até a data ser informada). O código U07.1 já indica confirmação.
  - O art. 8º da PRT 11.211 remete por erro material ao "Anexo 1 do Anexo X"; vale o Anexo V.
- **Sigilosos**: aids (34), HIV em gestante (35), HIV (36), sífilis (56), violência (66a) e violência sexual e
  tentativa de suicídio (66b).

## De-para de códigos

Código CID-10 ou CIAP-2 (por prefixo; vale o mais longo) → grupo do agravo. Homologados de saída: A37.9
(coqueluche), A93.0 (oropouche), B42 (esporotricose) e W64 (atendimento antirrábico). Os demais entram como
**propostos**: abrem o rascunho, mas com o aviso "mapeamento não homologado" até um técnico da vigilância
homologar (em lote, na aba *Códigos*). Um código pode indicar o contexto (P35.4 → zika congênita). T63 (contato
com animal venenoso) vai só para acidente por animal peçonhento; as agressões X85–Y09 e T74 abrem violência.

**Gestação**: HIV/aids, hepatite B, HTLV e toxoplasmose têm linhas próprias na gestação (itens 35, 33, 38 e 62),
que são grupos separados na lista. Com a linha de cuidado de gestante ativa, o mesmo código abre também a linha
da gestação (B58, toxoplasmose, só é notificável na gestação).

## Gatilho: quando o rascunho é aberto

| Evento | O que acontece |
|---|---|
| Assinatura do registro clínico com código | um rascunho por agravo encontrado; prazo da imediata a partir do início do atendimento |
| Encerramento do atendimento | CID principal; no **óbito**, a linha de óbito do grupo (dengue, zika, chikungunya, oropouche) ligada à notificação do caso |
| Internação | CID da admissão; o prazo conta do conhecimento (a suspeita pode surgir dias depois; decisão a validar com a vigilância) |
| Manual | quem atende escolhe o agravo na lista vigente na data do atendimento (tela *Vigilância* ou ficha do paciente) |
| ESAVI | botão *Notificar ESAVI* na dose registrada da sala de vacina (item 23, imediata); o prazo conta do conhecimento do evento adverso, não da aplicação; uma notificação ativa por dose |
| Varredura (a cada 5 minutos) | recupera registros assinados nas últimas 48 horas com código notificável (filtrados no banco) e reprocessa as falhas do encerramento e da internação registradas na auditoria; não recria o que a vigilância descartou |

- O gatilho **nunca bloqueia** a assinatura, o encerramento nem a internação: a falha fica na trilha de auditoria
  (`vigilancia.erro_gatilho`) e a varredura recupera.
- **Sem duplicatas**, comparando pelo **grupo** do agravo (trocar o subitem não abre outra) e separando a linha de
  óbito: o mesmo atendimento não gera outra notificação do agravo, nem reabre a que a vigilância **descartou**
  (um novo registro com o mesmo código não a recria; reabrir é manual); a mesma pessoa não recebe outra em 30 dias;
  agravos crônicos (hanseníase, HIV/aids, doenças relacionadas ao trabalho...) são notificados uma vez por pessoa;
  tuberculose, uma vez a cada 180 dias (recidiva e reingresso voltam ao Sinan); hepatites virais, uma vez por agente.
- **Óbito**: a linha de óbito liga-se ao caso ativo da pessoa no mesmo atendimento ou nos últimos 30 dias, inclusive
  notificado em outra unidade (UPA que transferiu para o hospital).
- **Linha do grupo**: óbito > anomalia indicada pelo código > gestante (linha de cuidado de gestante ativa no
  cadastro) > caso. Malária: região amazônica ou extra-amazônica pela UF da unidade.
- Aviso na tela: depois de assinar, um quadro mostra o agravo, a periodicidade, a contagem regressiva e o link
  para completar a ficha; ao encerrar com agravo notificável, a tela leva à ficha; na internação, um aviso.

## Ficha individual

Campos 1 a 16 e 20 a 33 da Ficha Individual de Notificação do **Sinan Net v5**, com os nomes do dicionário de
dados (TP_NOT, ID_AGRAVO, DT_NOTIFIC, ..., ID_PAIS); 17 a 19 são da notificação de surto. Os dados pessoais são
um retrato do cadastro na abertura (corrige-se no cadastro). Na ficha editam-se o subitem do mesmo agravo, o
critério, as datas de sintomas e de confirmação e os campos 12 (gestante), 13 (raça/cor), 14 (escolaridade),
22 (distrito), 29 (ponto de referência), 32 (zona) e 33 (país). Raça/cor e escolaridade do cadastro (tabelas do
e-SUS) são convertidas para os códigos do Sinan.

Ao **confirmar**: gestante obrigatório para mulher de 10 a 49 anos; datas não futuras; sintomas não depois da
notificação; Cartão SUS válido; unidade com CNES; valores dentro dos domínios. A confirmação grava a data, a
semana epidemiológica da notificação e dos sintomas e a comunicação à vigilância municipal pelo painel.

Numeração interna `AAAA/NNNNNN` (não é o número do sistema oficial, informado na fila de digitação; ver semana 24).

Trocar o subitem não pode **afrouxar** a notificação (de imediata para semanal ou com menos esferas) sem a
vigilância municipal, nem tirar o sigilo. Agravo notificado na confirmação (item 60) só é confirmado com a data de
confirmação. Confirmar, descartar, dar ciência e editar só valem se a notificação não mudou desde a leitura (duas
pessoas ao mesmo tempo não se sobrescrevem; a segunda recebe aviso de conflito).

## Prazos por esfera

| Esfera | Quando conta como cumprido |
|---|---|
| SMS, notificação imediata | ciência da vigilância municipal no painel ou comunicação registrada por meio rápido (telefone, e-mail, formulário, presencial). Confirmar no sistema não basta sozinho: a norma pede o meio mais rápido |
| SMS, notificação semanal | confirmação da notificação |
| SES e MS | comunicação registrada em até 24 horas do recebimento pela SMS: a ciência no painel ou a primeira comunicação à SMS por meio rápido, o que vier antes |

Situação mostrada: cumprido, no prazo, vence em até 6 horas, vencido, sem prazo. A tarefa periódica marca o
**prazo vencido** (linha do tempo) e **escala** a imediata confirmada sem ciência depois do tempo configurado
(padrão 60 minutos): aviso no painel e, se ligado, WhatsApp para os celulares do plantão pelo modelo
`vigilancia_alerta` (número da notificação, agravo e unidade; nunca nome, CPF, CNS ou endereço; agravo sigiloso
vai como "agravo de acesso restrito").

## Perfis

| Papel | O que faz |
|---|---|
| Médico, enfermagem, multiprofissional, serviço social, NIR, farmácia (`notificacao.registrar`) | abre, completa, confirma e descarta (só semanal em rascunho) as próprias notificações |
| Vigilância epidemiológica da SMS (novo) | vê todas, dá ciência, registra comunicações às três esferas, descarta, gere a lista local, o de-para, os contatos e o plantão |
| Núcleo de vigilância do estabelecimento (novo) | vê e completa as da sua unidade, abre as sigilosas da unidade, comunica à SMS |
| Gestor (`vigilancia.resumo`) | só contagens (no prazo, vencidas, repasses pendentes), sem lista nominal |

**Sigilo**: notificação de agravo sigiloso abre só para o autor, a vigilância municipal e o núcleo da mesma
unidade; cada leitura da ficha é auditada (`notificacao.ler_sensivel`), e também cada lista que mostra agravos
sigilosos de outros autores (`notificacao.listar_sensivel`). Para os demais, aparece como "agravo de acesso
restrito", sem nome, prazo, esferas, origem nem unidade (que bastariam para deduzir o agravo). Os eventos em tempo
real levam só o id (as salas incluem a recepção e os painéis de TV); a tela recarrega pela API, que aplica o
alcance. Na ficha do paciente, quem não pode abrir uma notificação a vê sem link.

## Telas

- **Vigilância** (`/vigilancia`): *Painel da vigilância* (cartões de imediatas aguardando ciência, rascunhos
  imediatos, repasses pendentes, vencidas, semanais em rascunho e descartes, calculados sobre todas as notificações
  com pendência, não só as mais recentes; lista com filtros e a ficha ao lado),
  *Minhas notificações*, *Descartes*, *Lista (LNNC)* (versões, linhas e lista local), *Códigos* (de-para e
  homologação em lote) e *Plantão e contatos*; o gestor vê a aba *Resumo*.
- **Ficha** (`/vigilancia/notificacao?id=`): prazo por esfera com contagem regressiva, campos da FIN, editar,
  confirmar, dar ciência, registrar comunicação, descartar com motivo, comunicações e linha do tempo.
- **Atendimento**: aviso após assinar e ida à ficha no encerramento. **Paciente**: cartão *Notificações
  compulsórias* com *Notificar agravo*. **Vacinas**: *Notificar ESAVI* em cada dose aplicada.

## API

`/api/vigilancia/...`: `painel`, `descartes`, `resumo`, `notificacoes` (POST manual), `notificacoes/minhas`,
`notificacoes/:id` (GET, PATCH), `notificacoes/:id/confirmar`, `/descartar`, `/ciencia`, `/comunicacoes`,
`pacientes/:id/notificacoes`, `catalogo/vigente?data=`, `catalogo/versoes` (GET, POST), `catalogo/versoes/:id`,
`codigos` (GET, POST), `codigos/homologar`, `codigos/:id` (PATCH), `contatos` (GET, POST, PUT), `configuracoes`
(GET, PATCH). As respostas de assinatura (`POST /clinical/notes/:id/sign`), encerramento e internação trazem
`notificacoes` com os rascunhos abertos. A tarefa periódica é `vigilancia` (a cada 5 minutos; também em
`POST /api/jobs/tick?tasks=vigilancia`).

## Semana 24 (VIG-1b + INT-4a)

### Base normativa (conferida em 01/11/2026)

| Tema | Regra | Fonte |
|---|---|---|
| Dengue e chikungunya | Sinan Online (o único agravo que segue nele além da chikungunya) | NT nº 6/2026-CGFAM/DPNI/SVSA/MS; página do Sinan no gov.br |
| Ficha de Notificação/Conclusão | Oropouche (A93.0), esporotricose (B42), HTLV (B33.3, Z22.6, Z20.8), hepatite B na gestação (Z22.8, Z20.5), doença falciforme (D57) e distúrbio de voz relacionado ao trabalho (R49) no **e-SUS Sinan**, com os campos 41 a 56 | página oficial do e-SUS Sinan; ficha e modelo de informação v2.0.2 (12/06/2025); NT nº 117/2024 (Oropouche) e nº 20/2025 (esporotricose) |
| Mpox | e-SUS Sinan, notificação em até 24 h | Ministério da Saúde, página da mpox |
| Covid-19 e Srag | SG por covid-19 **confirmada** no e-SUS Notifica em 24 h; Srag hospitalizada (síndrome gripal com dispneia, taquipneia e/ou SpO2 ≤ 94%) ou óbito por Srag no **Sivep-Gripe** | NT nº 11/2026-CGCOVID/DEDT/SVSA/MS |
| ESAVI | e-SUS Notifica | NT nº 6/2026-CGFAM/DPNI/SVSA/MS |
| Anomalias congênitas | sem ficha no Sinan: Declaração de Nascido Vivo (bloco VI, campo 41) ou Declaração de Óbito; identificada depois da DNV (até 1 ano de idade), formulário do Anexo 2 à vigilância municipal (à estadual, se fora do município de nascimento) em até 7 dias | NT nº 3/2026-SVSA/MS; NT Conjunta nº 54/2026-DAENT/DEMSP/SVSA |
| Demais agravos | Sinan Net, versão vigente do Sinan | — |
| Encerramento oportuno | 60 dias da notificação para os agudos; 180 dias para hepatites virais, leishmaniose tegumentar e visceral; Oropouche em 60 dias | Manual de Normas e Rotinas do Sinan (2ª ed., 2007), item 4.5.3; modelo de informação do e-SUS Sinan |
| REL | resultados de covid-19 e mpox (positivos, negativos e inconclusivos) à RNDS em até 24 h | Anexo V da PRC GM/MS nº 4/2017, arts. 22 a 26 |
| Violência contra a mulher | casos de **violência interpessoal contra a mulher** comunicados à autoridade policial em até 24 h da constatação, à autoridade de referência definida pela SES; crianças e adolescentes seguem o ECA e idosas o Estatuto da Pessoa Idosa; os arts. 14-D a 14-F foram revogados | Lei nº 10.778/2003, art. 1º, § 4º; Anexo V da PRC 4/2017, arts. 14-A a 14-C (PRT nº 1.077/2021 revogou os arts. 14-D a 14-F e o Anexo 4) |
| Sigilo da vítima | fora do setor saúde, a identificação só em caráter excepcional, em caso de risco à comunidade ou à vítima, a juízo da autoridade sanitária e com conhecimento prévio da vítima | Lei nº 10.778/2003, art. 3º, parágrafo único |

### Rota agravo → sistema oficial

Tabela com vigência (`official_system_routes`), semeada com as rotas acima e marcada por situação: confirmada em
nota técnica, **a definir com a SES** (caxumba, item 48: o art. 2º, I, e o Anexo 1 divergem) ou não confirmada
para o ano. A rota é escolhida pela data da notificação; uma linha da chave do subitem prevalece sobre a do grupo;
sem rota, Sinan Net. A vigilância municipal muda a rota na aba *Sistemas* abrindo nova vigência (a anterior fecha no
dia anterior; vigências sobrepostas são recusadas), com o ato ou acordo que a fundamenta.

### Fila de digitação e número oficial

- Ao **confirmar**, a notificação entra na fila do sistema de destino (*pendente*). A anomalia congênita não entra
  na fila: vira **lembrete** da DNV ou da DO, sem número.
- O digitador (vigilância municipal ou núcleo do estabelecimento, permissão `vigilancia.digitar`) informa o número
  gerado no sistema oficial e, se quiser, o lote; a notificação sai da fila (*digitada*). Formato conferido por
  sistema: Sinan Net até 7 dígitos (NU_NOTIFIC, varchar2(7) no dicionário, atribuído pela unidade); e-SUS Sinan
  com 12 dígitos no formato UFAANNNNNNNN (código IBGE da UF, ano e sequencial, conforme o dicionário de dados da
  notificação); Sivep-Gripe com 12 ou 14 dígitos (o dicionário diz 12; os dados abertos de 2023 em diante têm 14;
  o 1º dígito é o tipo da ficha, 3 na Srag hospitalizada); Sinan Online até 12 dígitos e e-SUS Notifica de 8 a 15
  (em geral 12), com validação larga porque o formato não está em documento nacional. O número é sempre o que o
  sistema oficial devolve: o OmniSaúde nunca o gera.
- **Número repetido**: recusado no mesmo sistema (descartadas não contam). No Sinan Net a chave é número + data
  da notificação + município + agravo do Sinan, então o mesmo NU_NOTIFIC é aceito em outro agravo, data ou
  município. O agravo segue a divisão do Sinan: as violências são uma ficha só; sífilis adquirida, em gestante
  (campo 12 ou CID) e congênita, tétano acidental e neonatal, toxoplasmose gestacional e congênita, sarampo e
  rubéola são agravos distintos (sem CID, como na notificação manual, a variante fica desconhecida e casa com
  qualquer uma do grupo).
- Só a vigilância municipal **desfaz** a digitação (com motivo, na linha do tempo); a notificação volta à fila.
- **Descartada** sai da fila e não recebe nem perde número; o número já informado fica como histórico e não
  impede outra notificação de recebê-lo (ex.: caso reclassificado e notificado de novo).
- Notificações confirmadas antes desta entrega (sem sistema de destino) entram na fila pela rota da data da
  notificação na primeira vez que o catálogo é carregado depois da atualização.

### Espelho, PDF e exportação

- **Espelho** (tela) e **PDF** da ficha na ordem da FIN do Sinan Net v5: NU_NOTIFIC, campos 1 a 33 com SEM_NOT
  depois de DT_NOTIFIC, SEM_PRI depois de DT_SIN_PRI e o DDD com o telefone; depois, o bloco de conclusão
  numerado como no sistema de destino (31 a 43 no Sinan Net; 46 a 56 e os campos 44, 45 e 49 a 53 no e-SUS Sinan).
  Cada linha mostra o valor e o código como se digita no sistema (datas dd/mm/aaaa, município com 6 dígitos, CID
  sem ponto, semanas em AAAASS). O dicionário não diz como as datas ficam no DBF exportado pelo Sinan Net: a
  exportação é para conferência e digitação, não para importar no Sinan.
- **Exportação CSV** (só a vigilância municipal; lista nominal): colunas com os nomes das variáveis do dicionário
  de dados, num cabeçalho fixo (DT_ENCERRA do Sinan Net e DT_CONCLU do e-SUS Sinan em colunas separadas), separador
  `;`, UTF-8 com BOM, período em dias locais da instituição, filtros de sistema e da situação da fila; até 20.000
  linhas por arquivo (acima disso, pede-se um período menor); sem filtro de situação, os lembretes de DNV/DO ficam
  de fora. Texto que a planilha leria como fórmula (começando
  com `=`, `+`, `-` ou `@`) sai com apóstrofo. A exportação é auditada, e cada notificação sigilosa exportada ganha
  a própria entrada na trilha.

### Investigação e encerramento

- **Sinan Net** (bloco genérico): 31 data da investigação, 32 classificação final (confirmado, descartado,
  inconclusivo), 33 critério (obrigatório no confirmado), 41 evolução, 42 data do óbito (obrigatória no óbito) e 43
  data do encerramento. Recusa: datas futuras ou fora de ordem, óbito pelo agravo em caso não confirmado, óbito
  antes dos sintomas.
- **e-SUS Sinan** (Oropouche e os demais da ficha de Notificação/Conclusão): 47 classificação (só confirmado ou
  descartado; o inconclusivo é gravado pelo próprio sistema no fim do prazo), 48 critério sempre (laboratorial ou
  clínico-epidemiológico), 54 evolução sempre (descartado só aceita óbito por outras causas ou ignorado), 44
  (trabalho) e 45 (desastre) obrigatórios e 49 (autóctone) obrigatório no confirmado. **Oropouche só encerra com os
  campos 47, 48 e 54 preenchidos.**
- A data do óbito só é aceita com evolução para óbito (2 ou 3).
- Encerrada, a ficha não é editada; a vigilância municipal **reabre** com motivo: a conclusão anterior fica no
  evento da linha do tempo, os campos voltam vazios e o critério da notificação volta ao de antes do encerramento.
  Encerrar não cumpre prazo de comunicação nem repasse: a encerrada segue nas pendências enquanto faltarem, e a
  SMS pode dar ciência nela (o escalonamento ao plantão e o prazo vencido olham as encerradas dos últimos 7 dias).
- Prazos de encerramento oportuno por agravo são configuráveis (referência na tela; não vêm ligados; linha mal
  escrita impede salvar) e o painel conta os vencidos.

### Gatilho por resultado de exame e por Srag

- **Resultado de exame**: o laudo de um exame do catálogo de vigilância (covid-19 RT-PCR e antígeno, mpox PCR,
  dengue NS1/IgM/RT-PCR, chikungunya, zika e Oropouche) é lançado com resultado qualitativo compatível com a técnica
  e, para covid-19 e mpox, a data e a hora da coleta. O **positivo** confirma a notificação ativa do agravo ou abre
  uma nova já confirmada, com o CID do exame; no item notificado na confirmação (SG por covid-19), o prazo de 24 h
  passa a contar do resultado. O aviso na tela do laudo mostra a notificação aberta ou confirmada. Negativo não abre
  nem descarta notificação.
- Positivo de quem tem a notificação do agravo **encerrada sem confirmação** (ou descartada no mesmo atendimento):
  não reabre sozinha; o resultado entra na linha do tempo (cada exame produz efeito uma vez só, mesmo se a tarefa
  periódica reprocessar uma falha), o aviso mostra a situação e o painel ganha o cartão "Positivo após encerramento ou descarte" (30
  dias) para a vigilância avaliar a reabertura. Quem lançou o resultado só vê o link da ficha se puder abri-la.
- Covid-19 de quem tem **Srag** em aberto: o resultado confirma a Srag (Sivep-Gripe) e não abre a SG (e-SUS
  Notifica). Srag em aberto ou encerrada sem descarte (confirmada ou inconclusiva) cobre a SG também na internação
  e numa evolução assinada depois, e o covid-19 positivo tardio é registrado nela (reclassificação no
  Sivep-Gripe); Srag descartada, ou encerrada como descartada, não impede a SG.
- Coleta até 5 minutos no futuro (relógio da estação adiantado) vale como a hora do servidor; além disso, é
  recusada.
- **Srag**: na internação, CID respiratório agudo **e** um sinal registrado na triagem (SpO2 ≤ 94%, dispneia ou
  desconforto respiratório, taquipneia para a idade) abrem o rascunho de Srag, que vai ao Sivep-Gripe. Só um dos
  dois vira **sugestão** no painel da vigilância (internações dos últimos 10 dias sem notificação de Srag); notificar
  pela sugestão liga a notificação à internação e à unidade do atendimento, não à de quem clica (na notificação
  manual, a unidade do atendimento vale quando a vigilância municipal notifica; o núcleo só notifica pela própria
  unidade). A NT não
  fixa a frequência da taquipneia: usamos os limites da OMS para crianças e 24 irpm para os demais.

### REL de covid-19 e mpox (INT-4a)

Documento REL 3.2.1 (perfis do projeto público da RNDS no Simplifier): Bundle `document` com a Composition
`BRResultadoExameLaboratorial-3.2.1`, a Condition da suspeita (B34.2 ou B04), a Observation
`BRDiagnosticoLaboratorioClinico-3.2.1` (LOINC do catálogo `BRNomeExameLOINC`, resultado DTNT ou RGNR, patógeno,
data da coleta e da liberação com fuso, executante pelo CNES) e o Specimen pela tabela do GAL. Vai pela fila da
RNDS (outbox `RNDS_REL`), para todo resultado, quando a RNDS e o envio do REL estão ligados (`relEnabled`, desligado
de saída) e é conferido pelo simulador. O REL v4 só está no Portal de Serviços e fica para a homologação.

### Comunicação à autoridade policial

- Exigida para **mulher de 18 a 59 anos** (idade na ciência do caso) com notificação de violência interpessoal;
  lesão autoprovocada (X60 a X84) e homens não entram. A exclusão da lesão autoprovocada é interpretação do art.
  14-A ("violência interpessoal") com o art. 2º, I, do Anexo V, que separa as duas; nenhuma norma a diz com todas
  as letras, e ela deve ser validada com a SES ou a assessoria jurídica. Prazo: 24 h da ciência, com contagem regressiva na ficha e
  no painel ("comunicações policiais" pendentes).
- Menina ou adolescente: a ficha orienta comunicar o **Conselho Tutelar** (ECA, art. 13). Idosa: autoridade
  policial, Ministério Público ou Conselho do Idoso (**Estatuto da Pessoa Idosa**, art. 19). Nesses casos o
  OmniSaúde não controla prazo.
- **PDF da comunicação**: o modelo padrão traz o estabelecimento, a data do atendimento e o número da notificação,
  **sem identificar a vítima** (nem o cabeçalho do paciente). A instituição pode editar o modelo (aba *Plantão*,
  com aprovação da procuradoria); só se ele usar `{paciente}`, `{nascimento}` ou `{endereco}` a identificação
  sai, e a auditoria registra isso.
- Na mesma nota, um código de agressão (T74, X85 a Y09) prevalece sobre o de lesão autoprovocada; uma agressão
  registrada depois liga a exigência na notificação já aberta (evento na linha do tempo).
- O **envio** é registrado como comunicação à "Autoridade policial" (quem atendeu também registra, mesmo em
  rascunho). Só a vigilância (municipal ou núcleo) **dispensa**, com justificativa (ex.: a vítima já comunicou, com
  protocolo), inclusive em notificação encerrada: quem tem o dever de comunicar não tira a exigência sozinho, nem
  descartando o rascunho (com a exigência ativa, o descarte é da vigilância).
- O resumo da gestão conta à parte as comunicações policiais vencidas.
- A comunicação pela SES quando a unidade não comunica (art. 14-B, § 1º) e o envio da ficha de comunicação à
  autoridade sanitária local (§ 2º) seguem os fluxos da vigilância municipal.

### Perfis (semana 24)

| Permissão | Quem |
|---|---|
| `vigilancia.digitar` (fila e número oficial) | vigilância municipal e núcleo do estabelecimento |
| `vigilancia.investigar` (encerrar e reabrir) | vigilância municipal e núcleo; reabrir e desfazer a digitação, só a municipal |
| `vigilancia.exportar` (CSV nominal) | vigilância municipal |

### Telas (semana 24)

- **Vigilância**: aba *Digitação* (fila por sistema, com contagem de pendentes e lembretes, informar número e
  lote), aba *Sistemas* (rotas com vigência e nova rota), exportação CSV, sugestões de Srag no painel e cartões de
  digitação pendente, encerramento vencido e comunicações policiais.
- **Ficha**: cartão do sistema oficial (rota, situação, número, desfazer), espelho e PDF, formulário de
  encerramento com a numeração do sistema de destino, cartão da comunicação policial (PDF, registrar envio,
  dispensar) e a orientação para menores de 18 anos e idosas.
- **Atendimento**: no laudo do exame, o exame de vigilância, o resultado qualitativo e a coleta; o aviso mostra a
  notificação aberta ou confirmada pelo resultado.
- **Plantão e contatos**: configuração do envio do REL, prazos de encerramento por agravo e modelo da comunicação
  policial.

### API (semana 24)

`/api/vigilancia/...`: `digitacao?sistema=&situacao=`, `notificacoes/:id/numero-oficial` (POST), `.../desfazer`,
`notificacoes/:id/encerrar`, `/reabrir`, `/espelho`, `/ficha.pdf`, `/comunicacao-policial.pdf`,
`exportacao.csv?de=&ate=&sistema=&situacao=`, `srag/sugestoes`, `sistemas` (GET, POST). O resultado de exame
(`POST /api/clinical/exams/:id/result`) aceita `examKey`, `qualitative`, `collectedAt`, `method` e `labCnes` e
devolve `notificacoes`.

## Pendências e limites

- **Acordo com a SES**: quem digita em cada sistema e o destino da caxumba (marcada "a definir"); contas dos
  digitadores em cada sistema oficial.
- **Números oficiais**: os formatos do Sinan Online e do e-SUS Notifica não estão em documento nacional; a
  validação é larga e deve ser ajustada com os primeiros números reais.
- **Lesão autoprovocada fora da comunicação policial**: interpretação a validar com a SES ou a assessoria jurídica.
- **REL**: credenciamento na RNDS e homologação (o REL v4 só está no Portal de Serviços); confirmar se a rede faz
  testes de covid-19 e mpox e com quais métodos (o catálogo traz os LOINC conferidos no pacote público).
- **Comunicação policial**: autoridade policial de referência definida pela SES e modelo aprovado pela procuradoria.
- O de-para de códigos precisa da homologação de um técnico da vigilância; até lá os rascunhos trazem o aviso.
- O modelo `vigilancia_alerta` precisa ser aprovado na conta do WhatsApp para o escalonamento por mensagem.
- Contatos da vigilância municipal e do CIEVS estadual, escala de plantão e lista complementar estadual ou
  municipal (se houver) dependem da instituição.
- O marco do prazo na internação (conhecimento, e não a admissão) é decisão a validar com a vigilância.
- Fichas de investigação específicas de cada agravo (além do bloco de conclusão) ficam para a próxima etapa da
  vigilância.
