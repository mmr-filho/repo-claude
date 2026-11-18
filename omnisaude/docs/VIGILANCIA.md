# Vigilância em saúde: notificação compulsória (VIG-1a, VIG-1b e VIG-1c)

Entregas das semanas 23 (notificação a partir do atendimento), 24 (investigação, encerramento, saída para os
sistemas oficiais, REL de covid-19 e mpox e comunicação policial; seção [Semana 24](#semana-24-vig-1b--int-4a)) e 27
(consolidação e detecção de surto; seção [Semana 27](#semana-27-vig-1c)).

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

Numeração interna `AAAA/NNNNNN` (não é o número do sistema oficial, informado na fila de digitação; ver semana 24),
sequencial por ano, sem colisão nem buraco mesmo com notificações criadas ao mesmo tempo (trava curta por instituição
e ano na criação).

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
| Encerramento oportuno | 60 dias da notificação para os agudos, inclusive a leishmaniose visceral; 180 dias para hepatites virais e leishmaniose tegumentar; Oropouche em 60 dias | Manual de Normas e Rotinas do Sinan (2ª ed., 2007), item 4.5.3, com a errata do GT-Sinan de 01/11/2007 (pp. 29 e 38: leishmaniose visceral em 60 dias); modelo de informação do e-SUS Sinan |
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
  o 1º dígito é o tipo da ficha, 3 na Srag hospitalizada); Sinan Online até 12 dígitos (o formato não está em
  documento nacional); e-SUS Notifica com 12 dígitos, no formato documentado pelo DATASUS (dicionários da exportação,
  11/2022, e da API, 12/2022): UF + ano com 2 dígitos + sequencial de 8 (UFAA + 8 desde 23/04/2020; AAUF + 8 nas
  notificações antigas), e 14 dígitos no ESAVI. Os "00" do modelo UFAA00NNNNNN não são fixos (o sequencial de SP
  passou de 999.999 por ano). A validação do e-SUS Notifica segue larga (8 a 15 dígitos) porque há fichas sem formato
  documentado. O número é sempre o que o sistema oficial devolve: o OmniSaúde nunca o gera.
- **Número repetido**: recusado no mesmo sistema (descartadas não contam). No Sinan Net a chave é número + data
  da notificação + município + agravo do Sinan, então o mesmo NU_NOTIFIC é aceito em outro agravo, data ou
  município. O agravo segue a divisão do Sinan: as violências são uma ficha só; sífilis adquirida, em gestante
  (campo 12 ou CID) e congênita, tétano acidental e neonatal, toxoplasmose gestacional e congênita são agravos
  distintos (sem CID, como na notificação manual, a variante fica desconhecida e casa com qualquer uma do grupo).
  Sarampo e rubéola são o **mesmo** agravo no Sinan Net (ID_AGRAVO B09; o CS_SUSPEIT 1 ou 2 não é campo-chave), como
  as meningites (G03.9): o mesmo NU_NOTIFIC na mesma data e município é recusado entre os dois (correção da semana 27).
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

## Semana 27 (VIG-1c)

Consolidação e detecção de surto: importação e conciliação das exportações oficiais, base consolidada sem dupla
contagem, diagrama de controle por agravo e território, estágios do plano de contingência, notificação de surto e
notificação negativa semanal com atesto do responsável. Pronto quando: o DBF do município importa sem duplicar; o
diagrama bate com a planilha; a unidade silenciosa aparece.

### Base normativa e técnica (conferida em 10/11/2026)

| Tema | Regra | Fonte |
|---|---|---|
| Exportação do Sinan Net | DBF dBase III em CP850 (byte 29 = 0x25), um arquivo por tipo: NINDINET (individuais), NNEGANET (negativas), NSURTNET (surtos) e um por agravo com a investigação (ex.: DENGNET). A mesma notificação sai no NINDINET e no DBF do agravo. A exportação é um retrato: excluídos não aparecem, sem marca | caderno e roteiro de exportação do Sinan Net; dicionário de dados v5; tabelas do SinanRelatórios |
| Sinan Online | DENGON e CHIKON. CLASSI_FIN 5 descartado; dengue 10, 11 (sinais de alarme) e 12 (grave); chikungunya 13; CRITERIO 3 = em investigação; EVOLUCAO 2 óbito pelo agravo, 4 óbito em investigação | dicionário de dados do Sinan Online, dengue e chikungunya (rev. 21/10/2015) |
| Chave do registro | número + data da notificação + município + agravo (a negativa troca o agravo pelo CNES); no e-SUS Sinan, número + agravo; no e-SUS Notifica, o número | Manual de Normas e Rotinas do Sinan (2ª ed., 2007); dicionários dos sistemas |
| Duplicidade | NDUPLIC_N = 2 (não contar) não é exportado nem contado; no e-SUS Notifica, "Cancelado" | Manual de Normas e Rotinas do Sinan (2007); dicionário da exportação do e-SUS Notifica |
| Diagrama de controle | para cada SE, mediana, Q1 (limite inferior) e Q3 (limite superior) da incidência de casos prováveis nos 5 anos anteriores | Plano de Contingência Nacional para Dengue, Chikungunya e Zika (MS, 2025), pp. 22-23 |
| Outras receitas | 7 anos e QUARTIL.EXC (NT nº 1/2023-CGARB); 10 anos (VigiEPI 2025); média + 1,96 DP com janela de 5 semanas (Diretrizes Nacionais de 2009, Anexo VIII) | documentos citados |
| Semana do caso | SE de início dos sintomas (SEM_PRI); caso provável = notificado menos descartado | Diretrizes 2009; VigiEPI; Guia de Vigilância em Saúde (6ª ed. rev., 2024) |
| População | estimativa anual do IBGE publicada no DOU (1º de julho); estimativas da RIPSA/MS no TabNet (popsvs, revistas todo ano, com a série passada refeita); Censo 2022 (V0001) por setor, bairro e distrito | Lei nº 8.443/1992, art. 102, e LC nº 143/2013; Nota Técnica RIPSA 01/2025; IBGE |
| Plano de contingência | estágios normalidade, mobilização, alerta e situação de epidemia; critérios municipais ligados por "E/OU"; ações por estágio e eixo; desmobilização depois de 4 SE de redução sustentada. O sistema sugere; a vigilância decide e registra | Plano de Contingência Nacional (MS, 2025), Apêndice B e item 7.2.3 (p. 52) |
| Surto | casos acima do esperado numa área pequena ou numa população institucionalizada. Vai ao módulo de surto do Sinan: agravo inusitado (pela síndrome), doença fora da lista, doença da lista com acordo entre gestores e 10% dos casos notificados individualmente, e DTA. O surto não substitui a notificação individual | Manual de Normas e Rotinas do Sinan (2007), itens 3.1.1 e 5.3.1 e Anexo A; Guia de Vigilância em Saúde (6ª ed. rev., 2024) |
| Prazo do surto | imediato (24 h) à SMS; com evento de saúde pública (item 22 da lista), também à SES e ao MS | Anexo V da PRC GM/MS nº 4/2017, art. 2º, V e VII, e Anexo 1, item 22 |
| Notificação negativa | comunicação semanal do responsável pelo estabelecimento de que não houve caso da lista na SE; data = último dia da SE; não cabe em semana com notificação individual, de surto ou agregado (RQ002), e cai quando uma delas é digitada (RQ003) | Anexo V da PRC nº 4/2017, art. 2º, IX; IN SVS nº 2/2005, art. 14; Manual de Normas e Rotinas do Sinan (2007); dicionário da negativa do Sinan Net |
| Regularidade do Sinan | o município fica irregular com 8 SE consecutivas sem notificação individual, de surto, de epizootia, de tracoma ou negativa; monitoramento mensal | PRC GM/MS nº 6/2017, arts. 454-A a 454-E, na redação da PRT GM/MS nº 1.573/2023 (revogou a PT SVS nº 47/2016) |
| Meta por unidade | 80% das unidades notificantes informando toda semana (positiva ou negativa) | indicador da vigilância da PFA (Informe PFA, CGVDI, dez/2025; Guia de Vigilância em Saúde); NT SESPA nº 01/2025 |

Sem regra federal: o prazo da negativa (dia e hora), o número de semanas da "unidade silenciosa" e o formato do atesto.
O padrão segue a NT SESPA nº 01/2025 (segunda-feira até 14h, para a SE anterior) e fica nas configurações da
instituição, editáveis em *Notificação negativa > Prazos e parâmetros*.

### Importação e conciliação

- **Envio** (zip, DBF ou CSV, até 95 MB): o tipo de cada arquivo é **detectado pelo conteúdo**, nunca pelo nome:
  NINDINET, DBF de agravo, NNEGANET, NSURTNET, DENGON, CHIKON, CSV do e-SUS Notifica, CSV do e-SUS Sinan; tabelas do
  Sinan (MUNICNET, REGIONET...) e a planilha de acompanhamento do surto (NU_CASO) ficam de fora com aviso. Antes de
  ler o corpo, o envio é recusado nestes casos, nesta ordem (o corpo não lido é descartado sem ser guardado):
  - parâmetro inválido, inclusive o nome do arquivo com caractere de controle: 400 VALIDACAO ("Nome do arquivo com
    caractere inválido (de controle)");
  - corpo que não é o arquivo cru (JSON, XML, `text/plain` ou formulário): 415 FORMATO;
  - Content-Length acima de 95 MB: 413;
  - período declarado pela metade, com data que não existe ou invertido: 400 PERIODO_INVALIDO;
  - o município já tem outra importação lendo ou aplicando, com sinal de vida recente em qualquer processo, ou a vez
    do processo está com a leitura ou a aplicação dele: 409 IMPORTACAO_OCUPADA "Outra importação está sendo
    processada agora. Tente de novo em alguns minutos.";
  - a vez do processo está com a leitura ou a aplicação de outro município: 409 IMPORTACAO_SERVIDOR_OCUPADO "O
    servidor está recebendo ou processando outros envios agora. Tente de novo em instantes.", sem ocupar memória;
  - outro envio do município ainda está chegando (um arquivo por município na memória, contando o pacote da SIGTAP):
    409 IMPORTACAO_SERVIDOR_OCUPADO "Outro envio da sua instituição está sendo recebido agora. Tente de novo quando
    ele terminar.";
  - o processo já tem 2 arquivos na memória, de qualquer município (importação ou pacote da SIGTAP): 409
    IMPORTACAO_SERVIDOR_OCUPADO "O servidor está recebendo ou processando outros envios agora. Tente de novo em
    instantes.".

  Depois do corpo, a vez é conferida de novo ao ser tomada: se outro município a tomou enquanto o arquivo chegava, o
  409 IMPORTACAO_SERVIDOR_OCUPADO sai depois da leitura, e o arquivo sai da memória. O envio que para de chegar por
  30 s recebe 408 ENVIO_PARADO "O envio parou de chegar. Envie o arquivo de novo.", e o que chega incompleto (o
  cliente caiu no meio) termina em 400 ENVIO_INCOMPLETO "O envio chegou incompleto. Envie o arquivo de novo."; nos dois
  casos, o arquivo sai da memória. A leitura do corpo cru e as cargas do processo estão em `docs/ARQUITETURA.md`.
- **Leitura em fluxo**: o zip é aberto pelo diretório central e cada arquivo é descompactado em pedaços, com o tamanho
  real e o CRC conferidos (o arquivo que descompacta mais do que o zip declara é recusado no primeiro pedaço). CSV e
  DBF são lidos em pedaços, só nas colunas usadas, e os registros normalizados vão para um arquivo temporário. Tetos:
  **150 MB descompactados e 400 mil registros por envio**; acima disso, a mensagem pede para exportar um ano por vez.
  O zip com mais de **1.000 arquivos** é recusado antes de ser lido. Dos arquivos ignorados, a lista e os avisos
  guardam os 50 primeiros e um "mais X". Arquivo do zip com senha ou compressão diferente de deflate fica de fora, com
  aviso. Uma prévia ou aplicação por vez no processo: o envio (antes de ler o corpo e de novo depois dele) e o aplicar
  que encontram outra em andamento recebem 409 IMPORTACAO_OCUPADA, quando ela é do mesmo município, ou
  IMPORTACAO_SERVIDOR_OCUPADO, com a mensagem do processo cheio, quando é de outro.
- **Uma parte por tipo de arquivo** em cada registro: a chave repetida em outro arquivo do mesmo tipo fica com a do
  último arquivo lido (pela ordem do nome), com aviso, e não conta como duplicada. Os lotes da prévia e da aplicação
  fecham em 500 registros ou 1.000 partes.
- **Trabalho longo em segundo plano**: a resposta espera até 20 s. Se a leitura ou a aplicação demorar mais (um envio
  grande no container de produção, com 1/4 de vCPU), a API responde 202 e a tela acompanha o andamento ("Lendo o
  arquivo…", "Aplicando…"); dá para sair da tela e voltar. Um sinal de vida a cada 15 s mostra que o trabalho segue.
  A transação da aplicação não bloqueia o sinal, nem mesmo com a linha da importação presa pelas chaves estrangeiras
  dos registros. Por isso a recuperação rodada por outra réplica ou pelo worker do job não desfaz uma aplicação viva.
  Parado há mais de 2 minutos (o servidor reiniciou), a leitura vira "Falhou" (envie de novo) e a aplicação volta à
  prévia, aplicável de novo (a transação desfez tudo). A falha depois do 202 fica no histórico com a mensagem; a que
  acontece dentro da espera responde como antes, sem deixar linha. Enquanto acompanha, a tela consulta só o andamento
  (sem a prévia nominal e sem auditoria) e mantém a prévia que já tem. Durante a aplicação, o detalhe também vem sem
  a prévia.
- **DBF**: código de página pelo byte 29 (0x25 e 0x02 CP850, 0x01 CP437, 0x24 CP860, CP1252); sem marca (0x00), vence
  a página que acerta mais letras portuguesas (empate: CP850). A tela mostra a codificação e permite trocar e refazer a
  prévia. Datas vazias viram nulo; arquivo regravado pelo R (cabeçalho de 26/07/1995) recebe aviso. Só é DBF o
  cabeçalho coerente (versão, data, descritores de campo e terminador): um CSV nunca é lido como DBF.
- **Dengue e chikungunya** (A90 e A92.0) são sempre do Sinan Online, venham do DENGON, do CHIKON, do NINDINET ou de um
  DBF de investigação sem as marcas do Sinan Online: a mesma notificação não vira dois registros. O registro antigo
  gravado no Sinan Net muda de sistema na aplicação (a prévia mostra a mudança).
- **Surto do Sinan Net (NSURTNET)**: a data do 1º sintoma do surto é a DT_PRIM_SI; a DT_SIN_PRI só vale sem ela. Com
  a planilha dentro do próprio arquivo (linhas com NU_CASO), os campos de caso não entram no registro do surto:
  DT_SIN_PRI, SEM_PRI, residência, sexo, idade, iniciais, óbito, evolução, classificação e local de infecção; na linha
  de caso, a semana do surto sai da DT_PRIM_SI. Essas linhas também não contam como duplicadas.
- **Mpox no e-SUS Sinan** segue a ficha de Mpox: evolução 1 óbito e 2 cura (comparada já traduzida); classificação
  2 e 6 descartado, 3 (provável), 5 (perda de seguimento) e 8 inconclusivo, 4 (suspeito) em investigação; a data de
  conclusão (DT_CONCLUSÃO) é o encerramento.
- **CSV**: sem BOM; UTF-8 e, se inválido, Windows-1252 com aviso; separador `;` ou `,`; cabeçalho comparado sem
  acento e com sinônimos. Arquivo regravado pelo Excel (número em notação científica no número da notificação, CPF ou
  CNS) é recusado. Colunas de contato (telefone, e-mail, endereço, notificante) são descartadas na leitura.
- **Caractere de controle dentro do arquivo**: a leitura tira o caractere nulo e os demais caracteres de controle
  (U+0000 a U+001F e U+007F a U+009F) da célula do CSV, menos a tabulação, o LF e o CR (fazem parte do texto e da
  quebra de linha dentro das aspas), do campo do DBF e do nome do arquivo dentro do zip. Cada sequência deles vira um
  espaço, e o arquivo ganha um aviso: no CSV e no DBF, "N campo(s) com caractere de controle foram limpos (cada
  sequência deles virou um espaço)."; no nome, também no arquivo que fica fora da importação, "O nome do arquivo dentro
  do zip tinha caractere de controle: foi limpo (cada sequência deles virou um espaço).". Por causa desses caracteres, o
  envio não cai mais com 400 VALIDACAO na prévia ou no aplicar, nem com ERRO_INTERNO depois do 202. O texto com algum
  nulo perdido no começo continua lido como CSV; só fica fora, com "Formato não reconhecido (nem DBF nem CSV)", o
  arquivo com nulo em mais de 1% dos primeiros 4 KB (e em mais de 8 bytes), como o texto em UTF-16 e a planilha.
- **Prévia**: lê, normaliza (município de 7 dígitos comparado pelos 6 primeiros, ano epidemiológico pelo SEM_NOT e
  SEM_PRI, nunca pelo NU_ANO), junta por chave dentro do envio (NINDINET + DBF do agravo viram um registro só) e
  compara com o banco: lidos, novos, alterados, iguais, recusados com o motivo, duplicados no arquivo e ausentes
  previstos (os registros do banco que não vieram, dentro do que algum arquivo do envio cobre, cada um contado uma
  vez; a cobertura está em *Aplicar*). A prévia expira em 24 horas (padrão das configurações). O período declarado no
  envio vale mais que o lido; data que não existe no calendário ou período invertido são recusados. Num arquivo de um
  agravo ou de uma ficha sem período declarado (DBF do agravo, DENGON, CHIKON, CSV do e-SUS Sinan ou do e-SUS
  Notifica), o período lido vai da primeira à última notificação, e a prévia avisa: declare o período exportado, senão
  as semanas das pontas ficam fora do canal endêmico. O DBF do agravo enviado junto com o NINDINET não avisa. O fim da
  cobertura não passa da data local (fuso da instituição) do primeiro envio do arquivo, o mais antigo com o mesmo
  SHA-256, em qualquer situação: a exportação não traz o que veio depois dela, e reenviar o arquivo para declarar o
  período não estende a cobertura. Vale para os ausentes, para o "só no OmniSaúde" e para a base consolidada, também
  no período lido. O período declarado que começa depois desse dia não marca nada, com o aviso "O período declarado
  começa depois do primeiro envio deste arquivo (DD/MM/AAAA): nada do período fica marcado como ausente."
- **O mesmo arquivo de novo** (mesmo SHA-256): sem período declarado, se o arquivo já tem uma aplicação valendo, não
  cria nada, e a resposta aponta essa importação; com período declarado, só a aplicação com o mesmo período faz isso.
  Com outro período declarado, gera uma prévia nova, que avisa: "Este envio substitui a importação de DD/MM/AAAA do
  mesmo arquivo (período …). A cobertura passa a ser a deste envio, e N registro(s) que ela deu como ausentes
  voltam." (com N = 0, termina em "A cobertura passa a ser a deste envio."). O período citado diz se foi declarado ou
  lido das notificações. Aplicada, ela **substitui** a anterior, que passa a SUBSTITUIDA (`superseded_by` aponta a
  nova): vale só a aplicação mais recente do arquivo, e os registros não duplicam. Para voltar ao período lido,
  declara-se esse período.
  - Os ausentes que a anterior marcou (`official_records.absent_import_id`), nesta ordem:
    1. os que vieram no arquivo voltam;
    2. os que estão dentro da cobertura nova e fora do arquivo seguem ausentes, agora atribuídos à nova, com o
       "ausente desde" de quando sumiram: reaplicar o mesmo arquivo não reinicia essa data;
    3. os de fora da cobertura nova seguem ausentes quando outra importação APLICADA confirma a ausência: de
       qualquer arquivo, aplicada antes ou depois da substituída (nunca ela, a nova ou outra substituída na mesma
       aplicação), aplicada depois da última vez que o registro veio (`last_seen_at`) e com, na cobertura gravada,
       uma entrada que inclui o registro. A marca passa para a mais recente delas (pelo `applied_at`; no empate, a de
       maior id), com o "ausente desde" mantido. É o caso do registro excluído no Sinan que a exportação nova do
       período também não traz;
    4. os demais voltam.
  - Cada aplicação grava em `apply_result.cobertura` a cobertura dos ausentes que usou (a lista de *Aplicar*, já com
    o fim no primeiro envio, cada entrada com o tipo do arquivo de onde veio, `tipoArquivo`). A aplicação gravada sem
    ela (de antes desta regra, como a da demonstração) e a entrada fora do formato não confirmam ausência. A base
    consolidada e a conciliação também leem dela o que cada arquivo cobre (*Cobertura dos ausentes, por arquivo*). A
    API não mostra a cobertura: o resultado da aplicação vem sem ela no detalhe, na lista e na resposta do aplicar.
  - A contagem "voltam" da prévia segue a mesma regra; as aplicações do mesmo arquivo não confirmam, porque vão ser
    substituídas.
  - O resultado da aplicação lista as substituídas (`substituidas`: envio, aplicação, período, se ele foi declarado e
    quantos voltaram, em termos líquidos: os ausentes dela menos os que continuam e os confirmados). As unidades e
    semanas dos que voltaram entram na reconciliação da negativa logo depois da aplicação.
  - A SUBSTITUIDA não pode ser aplicada nem descartada (409), mantém o resultado da aplicação dela e não cobre nada:
    na conciliação, no resumo e na base consolidada, só a APLICADA cobre.
- **Aplicar**: grava pela chave natural, **campo a campo**: valor preenchido sobrescreve; valor vazio só apaga o campo
  que o mesmo tipo de arquivo tinha gravado (o NINDINET não apaga a classificação que veio do DBF do agravo). Registro
  do banco que não veio no envio, dentro do que algum arquivo do envio **cobre**, fica **ausente** (nunca apagado), com
  a importação que o marcou, e volta se reaparecer. Liga a unidade pelo CNES e roda a conciliação automática, numa
  transação só: se cair no meio, nada é gravado. A transação pega a trava da importação e logo depois a da
  conciliação, esperando, antes de gravar (sempre nessa ordem). Os registros alterados são gravados em lote, e as
  divergências dos pares vinculados que mudaram são recalculadas em lote (250 por UPDATE). Importar o mesmo DBF de
  novo não duplica.
- **Cobertura dos ausentes, por arquivo**: a cobertura do envio é a lista das coberturas dos arquivos, somadas linha a
  linha na leitura. Cada arquivo cobre:
  - o sistema e o tipo dele;
  - os agravos (no e-SUS Notifica, as fichas) e o período das linhas dele que são do sistema do arquivo, ou o período
    declarado no envio, que vale para todos os arquivos. A dengue ou a chikungunya de um NINDINET ou de um DBF do
    Sinan Net é do Sinan Online e não cobre nenhum dos dois. No e-SUS Notifica, a ausência só vale dentro da mesma
    ficha (o CSV da síndrome gripal só cobre a covid-19; arquivo sem ficha identificada não marca ausente);
  - os municípios de notificação das linhas, mais o do município, e a linha sem município, se houver;
  - no e-SUS (Notifica e Sinan), o CNES do arquivo quando todas as linhas da cobertura têm CNES e é um só (a exportação
    do autocadastro de um estabelecimento): os ausentes dele ficam nesse estabelecimento. Senão, o arquivo cobre o
    município inteiro, e só ele: o arquivo de um CNES só continua restrito ao CNES dele com o CSV do município no
    mesmo envio. `official_imports.files[].cnes` segue a mesma regra, arquivo por arquivo.

  O fim de cada entrada não passa da data local do primeiro envio do arquivo (*Prévia*). O registro que veio em mais
  de um arquivo (o NINDINET e o DBF do agravo; a mesma chave em dois arquivos do mesmo tipo) entra na cobertura de cada
  um. Assim, os mesmos arquivos dão os mesmos ausentes num zip ou em envios separados, e um zip com o DENGON de 2023 e o
  de 2025 não cobre 2024. A exceção é o fim no primeiro envio, procurado pelo SHA-256 do envio, e não pelo de cada
  arquivo do zip: o arquivo antigo reenviado dentro de um zip novo, com um período declarado além da data da
  exportação, fica com o fim no primeiro envio do zip, e não no dele (*Pontos de atenção*). As entradas iguais (mesmo
  tipo de arquivo, sistema, tipo, agravos, fichas, período e municípios, restritas ou não a um estabelecimento) viram
  uma só, com os CNES unidos, para a consulta não crescer com o zip de muitas unidades. O registro dentro de duas
  entradas conta uma vez na prévia, também sem CNES, sem município, sem agravo ou sem ficha: o filtro de cada entrada
  põe a guarda de não nulo em cada uma dessas colunas, e a prévia exclui de cada entrada o que as anteriores que se
  cruzam com ela já contaram sem perder o registro com coluna nula. Os ausentes previstos (a contagem e a aba Ausentes,
  até o teto da amostra) são os que a aplicação marca, e o "voltam" do aviso da substituição é o "voltaram" do
  resultado. A mesma lista vale na prévia, na aplicação, na substituição do mesmo arquivo, no
  `apply_result.cobertura`, na base consolidada e na conciliação. A prévia avisa, por sistema do e-SUS: "e-SUS Notifica:
  o envio traz um CNES só (X): os ausentes valem só para esse estabelecimento." quando todos os arquivos daquele
  sistema são do mesmo estabelecimento; senão, com algum arquivo de um CNES só, "e-SUS Notifica: N arquivo(s) de um
  estabelecimento só (a.csv, CNES X; b.csv, CNES Y; e mais K): os ausentes de cada um valem só para o estabelecimento
  dele.", com até 5 arquivos citados e, havendo arquivo do município inteiro no mesmo sistema, " Os outros arquivos do
  e-SUS Notifica valem para o município inteiro." (o mesmo para o e-SUS Sinan).

  A base consolidada (as SE cobertas) e a conciliação (a cobertura do resumo e o "só no OmniSaúde") leem, de cada
  importação APLICADA, essa lista gravada no `apply_result.cobertura`: o arquivo cobre nelas o que cobre nos ausentes,
  só pelas linhas do sistema dele, arquivo por arquivo, com o período declarado no envio (ou o das linhas do sistema
  do arquivo). O fim é cortado de novo na leitura pela data local do primeiro envio do arquivo, o que, com dado real,
  dá o mesmo da prévia. O tipo do arquivo de cada entrada diz o que ela cobre: o NINDINET, todos os agravos do Sinan
  Net; o DBF do agravo e o CSV do e-SUS Sinan, os agravos que vieram (na conciliação, com os grupos do mesmo agravo do
  Sinan); o DENGON e o CHIKON, a dengue e a chikungunya; o CSV do e-SUS Notifica, as fichas. A entrada de um CNES só,
  ou a que junta arquivos iguais de vários CNES, cobre na conciliação só esses estabelecimentos e na base consolidada
  não cobre a SE. Com isso, o NINDINET não cobre a dengue nem a chikungunya (Sinan Online) em ano nenhum, e o período
  dele é o das linhas do Sinan Net; a zika (A92.8) é do Sinan Net, e o NINDINET a cobre. A aplicação gravada sem a
  lista (a da demonstração, dado antigo) ou com alguma entrada individual sem o tipo do arquivo (gravada antes desta
  regra) é lida pelo `official_imports.files`, como antes: agravos e período de todas as linhas do arquivo, e o
  NINDINET com linhas de dengue cobre a dengue no período dele. Os agravos e o período de `files[]` continuam contando
  todas as linhas: são o que a tela mostra do arquivo.
- **Conciliação** em degraus:
  1. número oficial informado na fila de digitação, mesmo agravo do Sinan e data a até 7 dias;
  2. CNS ou CPF, mesmo agravo e data a até 7 dias;
  3. nome normalizado (a mesma normalização dos dois lados), nascimento e sexo: só sugestão;
  4. sem identificação: só nas contagens.

  Os degraus 1 e 2 só ligam sozinhos com candidato único dos dois lados. O agravo comparado é o do Sinan, não o grupo
  do catálogo: a violência sexual (T74.2) casa com a violência interpessoal (Y09). "Não é o mesmo caso" fica gravado e
  não volta como sugestão. O vínculo automático confere a rejeição no próprio UPDATE, então não liga um par rejeitado,
  e pula a notificação e o registro que já são duas linhas da planilha do mesmo surto aberto: o par fica nas
  sugestões, com "; as duas linhas estão no surto AAAA/NNNN" no motivo. A tarefa `vigilancia` também liga sozinha o
  registro à notificação que ganhou o número depois da importação. Ela tenta as travas da importação e da conciliação
  sem esperar e pula a rodada se alguma estiver ocupada.

  Vínculo manual e desvínculo pedem motivo e são auditados. No diálogo "Vincular…" do registro, a busca é nas
  candidatas ao vínculo: as notificações notificadas ou encerradas sem vínculo, mesmo fora da cobertura das
  importações (a do mesmo caso feita em outra unidade ou depois do envio também aparece), com o sigilo das listas e o
  agravo com os grupos do mesmo agravo do Sinan; o diálogo da notificação continua buscando em "só no oficial". Ao
  vincular, a tela oferece preencher o número oficial da notificação (mesma regra da fila de digitação). A notificação
  e o registro que já são duas linhas do mesmo surto aberto não se vinculam: 409 CASO_DUPLICADO_NO_SURTO "A
  notificação e o registro <número> são linhas do surto <AAAA/NNNN> (casos <a> e <b>). Retire uma das linhas da
  planilha antes de vincular."; surto encerrado ou descartado não impede o vínculo.

  Vincular, desvincular e rejeitar (e, antes de preencher o número oficial, a conferência da trava) tentam a trava da
  conciliação em transações curtas; sem ela, esperam 100 ms fora da transação, sem prender conexão, e tentam de novo
  por até 3 s. Se ela não sai (uma importação sendo aplicada ou o vínculo automático da tarefa), respondem 409
  CONCILIACAO_OCUPADA "A conciliação está sendo atualizada agora (importação ou vínculo automático). Tente de novo em
  instantes." e não gravam nada. Rejeitar um par que o vínculo automático ligou durante a espera responde "O par está
  vinculado: use desvincular".
- **Listas**: resumo, só no oficial, só no OmniSaúde, divergentes (situação, evolução e data de encerramento),
  sugestões, **vinculados** (com o método e a data do vínculo; o par pode ser desvinculado com motivo), candidatas ao
  vínculo e bairros sem correspondência. Nos bairros, a lista vem com contagem e em ordem decrescente de registros; os
  até 5 bairros parecidos são calculados só para a página, com um pré-filtro pelo comprimento e a distância de edição
  com teto (os mesmos candidatos, na mesma ordem, da conta completa), cedendo o laço de eventos entre um nome e outro;
  o resumo só conta os nomes. O apelido novo vai para o bairro do território e vale na próxima consulta. Tudo é
  contado e paginado no banco (50 por página), sem carregar a base.

  A busca (`busca`, nas listas e nas candidatas ao vínculo; a rota dos bairros a confere, mas não a usa) perde os
  espaços das pontas, aceita até 60 caracteres e recusa qualquer caractere de controle (U+0000 a U+001F e U+007F a
  U+009F: o nulo, a tabulação, a quebra de linha no meio, o DEL) com 400 VALIDACAO "Dados inválidos", com
  `details: [{ path: 'busca', message: 'Busca com caractere inválido (de controle)' }]`; o espaço comum passa. O nome
  do apelido de bairro segue a mesma regra ("Nome do bairro com caractere inválido (de controle)").
- **Só no OmniSaúde** é a notificação notificada ou encerrada, sem vínculo, dentro do que algum arquivo aplicado
  **cobre**:
  - o DBF de um agravo cobre aquele agravo e os grupos do catálogo com o mesmo agravo do Sinan (o DBF do Y09 cobre
    também a violência sexual e a tentativa de suicídio);
  - o CSV do e-SUS Notifica cobre a ficha dele;
  - só o NINDINET cobre o Sinan Net inteiro.

  Só a importação APLICADA cobre (a substituída, não). O arquivo cobre o que cobre nos ausentes, só pelas linhas do
  sistema dele (o NINDINET com algumas linhas de dengue não cobre a dengue), e o período coberto vai só até a data
  local do primeiro envio do arquivo: a exportação não traz o que veio depois dela. O arquivo do e-SUS de um
  estabelecimento só (o mesmo critério da cobertura dos ausentes, arquivo por arquivo; `files[].cnes`) cobre só as
  notificações das unidades com esse CNES, mesmo com o CSV do município no mesmo envio, e a tela mostra "só o CNES N".
  A regra fica num lugar só (`cobertura-importacao.ts`), que a conciliação e a base consolidada usam, lendo o
  `apply_result.cobertura` de cada importação aplicada, arquivo por arquivo, ou `files[]` na aplicação gravada sem ela
  (*Cobertura dos ausentes, por arquivo*).
- A evolução das divergências é comparada na numeração da ficha de notificação (a do Mpox é traduzida antes).
- **Sigilo**: registro de grupo sigiloso (aids, HIV, sífilis, violências) sai sem identificação para quem não tem
  `notificacao.sensivel`; as listas identificadas são auditadas como a exportação CSV.

### Base consolidada

Registros oficiais individuais, não excluídos e não ausentes, mais as notificações do OmniSaúde notificadas ou
encerradas, não descartadas e **sem vínculo** com registro oficial: o par vinculado conta uma vez, pelo registro
oficial. O registro ligado a uma notificação conta no grupo da notificação quando os dois grupos são do mesmo agravo
do Sinan, o que hoje só acontece na ficha do Y09 (violência interpessoal, violência sexual e tentativa de suicídio);
nos demais casos, conta no grupo do registro, que é a verdade oficial (a dengue reclassificada como chikungunya conta
em chikungunya). A semana é a de início dos sintomas; sem ela, a da notificação (contada à parte, com aviso). Base de
casos prováveis (situação diferente de descartado), notificados ou confirmados. Território: município pela
residência; bairro e localidade pelo código ou pelo nome do bairro do registro (com os apelidos) e pelo quarteirão da
residência da notificação. Os quarteirões são localizados em lote, com duas consultas para todas as notificações e o
mesmo resultado da consulta de um ponto (`docs/TERRITORIO.md`): o polígono que contém o ponto, com a borda contando
como dentro; fora de todos, o mais próximo até 15 m; no empate (divisa, quarteirões sobrepostos), o de menor área e
depois o de menor id. Da ficha da notificação sem quarteirão, a base lê só o nome do bairro.

**Cobertura** por SE. A semana sem caso só vale zero em três situações:
- está no período de um arquivo de importação aplicada (a substituída não conta) que cobre o agravo, com o que o
  arquivo cobre nos ausentes, só pelas linhas do sistema dele (*Cobertura dos ausentes, por arquivo*): o NINDINET com
  algumas linhas de dengue não cobre a dengue, e o período dele é o das linhas do Sinan Net. O período vai até a data
  local do primeiro envio do arquivo, e o arquivo do e-SUS restrito ao CNES não cobre semana nenhuma; os registros dele
  contam;
- o OmniSaúde já estava em uso: da SE em que a primeira notificação notificada ou encerrada entrou no sistema em
  diante. A data de conhecimento retroativa não conta;
- a semana tem caso.

Fora disso, a semana fica fora do canal (nula, diferente de zero). O ano coberto só em parte aparece como "coberto em
parte", com as SE cobertas. O ano de referência sem o DENGON (ou o CHIKON) fica coberto só nas SE com caso do agravo
("Coberto só nas SE … (SE com caso do agravo)"): por elas, ele entra na lista dos anos de referência do canal, e nas SE
sem caso fica fora do canal, que nelas não muda. Nos anos de antes do Sinan Online, a dengue vem no NINDINET e no DBF
do agravo do Sinan Net, que não a cobrem: a série histórica desses anos fica com as SE sem caso descobertas
(*Pontos de atenção*).

### Diagrama de controle e receitas

- **Receita por agravo** (tabela `diagram_settings`), escolhida a partir de um modelo: MS 2025 (padrão: QUARTIL.EXC,
  5 anos, sem janela, incidência de prováveis), NT 1/2023 (7 anos), VigiEPI 2025 (10 anos) e Diretrizes 2009 (média e
  desvio-padrão amostral, LS = média + 1,96 DP, janela de 5 semanas agrupada, borda circular, ano em análise com todos
  os notificados). Na NT 1/2023, a janela de 5 semanas fica como opção suavizada (cada ano suavizado antes dos
  quartis), nunca agrupada.
- **Funções iguais às do Excel** (MED, QUARTIL.EXC, QUARTIL.INC, MÉDIA, DESVPAD.A e ARRED, com meia unidade para longe
  do zero), em precisão total; o arredondamento é só da tela. A SE 53 do histórico soma na SE 52; a SE 53 observada é
  comparada com o canal da SE 52. Com menos de 3 valores numa SE, o QUARTIL.EXC fica indefinido e a SE fica sem canal;
  com poucos casos na referência, a tela sugere a curva epidêmica.
- **Anos excluídos** com motivo (decisão da vigilância). O sistema só **sugere** anos epidêmicos pela regra do painel
  da SES-GO (anos com contagem de SE acima de média + 1 DP igual ou maior que o Q3 das contagens; interpretação
  documentada).
- **Congelar**: o canal do ano é gravado com a receita, a fonte e a versão da população e os avisos do cálculo (nova
  versão ativa; a anterior fica inativa). Sem canal congelado, a tela mostra a prévia calculada na hora. Não se congela
  com ano ainda incompleto na referência (o ano em curso, ou o recém-fechado enquanto tem SE incompletas): a tela diz a
  SE a partir da qual se poderá congelar.
- **Agravo sigiloso** no diagrama: os sigilosos do catálogo nacional (aids, HIV, HIV na gestação, sífilis e
  violências) mais tuberculose, hanseníase, hepatites virais e hepatite B na gestação (Lei 14.289/2022, art. 1º e 2º),
  e a linha marcada sigilosa no catálogo da instituição. É uma lista única, da API e da tela, que vale mesmo que o
  catálogo da instituição desmarque a linha. Diagrama, CSV, anos epidêmicos, congelar e configuração
  (`diagrama/configuracao/:grupo`, com o motivo dos anos excluídos) só para a vigilância epidemiológica municipal com
  `notificacao.sensivel`, com cada leitura auditada; os demais papéis, gestor e núcleo inclusive, recebem 403
  AGRAVO_SIGILOSO. O agravo sigiloso também fica fora do plano de contingência (o plano recusa; indicadores e excessos o
  pulam) e das sugestões de surto pelo diagrama. A marca `sensitive` do catálogo nacional **não mudou**: tuberculose,
  hanseníase e hepatites seguem sem ela nas notificações, porque essa marca governa o acesso às notificações nos outros
  módulos (ficha, mapa de casos, conciliação, surto), e essa decisão é da instituição.
- **Eixo** epidemiológico (SE 1 a 52/53) ou sazonal (SE 27 a 26 do ano seguinte, cada ponto com o canal do seu ano).
  As semanas incompletas (2 por padrão, contando a em curso) aparecem tracejadas.
- **CSV** com `;`, vírgula decimal e BOM: uma coluna por ano de referência, os limites, o observado e, no cabeçalho, as
  fórmulas do Excel equivalentes, para refazer a conta na planilha.
- O canal **bate com os exemplos publicados**: VigiEPI (dengue em Londrina, 26 SE: igualdade exata partindo dos casos
  e da população RIPSA de cada ano; QUARTIL.INC não acerta), VigiEPI meningocócica mensal, Diretrizes 2009 Anexo VIII
  (média + 1 DP: o anexo usa 1 DP, não 1,96; a SE 2 publicada não se reproduz por nenhuma regra) e o exemplo da
  Microsoft do QUARTIL.EXC. A Tabela 1 da NT 1/2023 só se reproduz com QUARTIL.INC e o ano em análise na referência
  (exemplo inconsistente da própria NT, com os rótulos dos limites trocados).

### População

- Tabela `population_estimates`: ano, nível (município, localidade, bairro), território, população, fonte (IBGE/DOU,
  RIPSA, Censo 2022, informada) e versão. A tela aceita colar "ano;população".
- A incidência de cada ano usa a população **daquele ano**, da **mesma fonte e versão** em todos os anos, inclusive o
  ano em análise (o exemplo do VigiEPI mistura RIPSA na série e Censo 2022 no ano observado, o que infla a curva em
  cerca de 3,8%). Ano de referência sem a fonte escolhida sai do canal com aviso; no ano em análise, vale o último ano
  da mesma série, marcado "repetida".
- Bairro e localidade sem estimativa anual: estimativa do município no ano × fração do território no Censo 2022,
  marcada "estimada" (inferência nossa, a validar com a vigilância).
- A RIPSA refaz a série toda a cada ano: o canal congelado guarda a versão usada, e a tela avisa quando a população
  mudou depois do congelamento.
- Na tela, a tabela *População e cobertura por ano* mostra a fonte uma vez, acima da tabela, quando ela (fonte e
  versão) é a mesma em todos os anos; a coluna Fonte só aparece quando a fonte varia.

### Plano de contingência

- **Plano** (tabela `contingency_plans`) criado a partir do modelo do MS 2025 ou copiado de outro, editável só em
  rascunho e posto em vigor com data. O vigente anterior do mesmo escopo é arquivado até a véspera dessa data, ou até
  a própria data se começou nela (a tela diz "Vigorou só em DD/MM/AAAA"). Criar, editar e pôr em vigor tomam a mesma
  trava do escopo (`contingencia-plano:<escopo>`) e só depois leem a última versão, o plano e o vigente: a versão é
  única no escopo; o mesmo rascunho posto em vigor duas vezes ao mesmo tempo dá 409 "O plano já está em vigor" no
  segundo pedido; dois rascunhos entram em ordem (o segundo arquiva o primeiro) ou o segundo recebe 422
  VIGENCIA_INVALIDA, se começar antes do vigente; e a edição do rascunho que entrou em vigor no meio recebe 409 "Só o
  rascunho pode ser editado: este plano está em vigor. Faça uma cópia para mudar.", sem mudar o plano em vigor. A
  migração 0031 tem o índice único (escopo, versão) e a restrição de que a vigência não termina antes de começar.
  Modelo: estágios normalidade (preparação), mobilização, alerta e situação de epidemia; dengue, chikungunya e Zika;
  critérios do Apêndice B com a fonte e a página; ações por estágio e eixo (gestão, vigilância, laboratório, vetores,
  APS, atenção especializada, comunicação).
- **Critérios automáticos** sobre o canal e a base consolidada: incidência acima da mediana por 4 SE seguidas
  (mobilização; as semanas acima do limite superior também contam, para a sugestão não cair quando a curva passa do
  limite antes de completar 4 SE: interpretação), acima do limite superior por 4 SE (alerta), percentual de graves e
  com sinais de alarme (> 1% e > 2%), letalidade (> 0,05% e > 0,07%; > 3% e > 5% entre os graves) e óbitos em
  investigação (> 1% e > 2%). Só semanas completas contam.
- **Critérios manuais** (nowcasting do InfoDengue, positividade do RT-PCR e do teste ZDC, sorotipo, atendimentos): a
  vigilância responde a cada semana; sem resposta, o critério fica "não avaliado", nunca "atendido".
- **Sugestão**: combinação "qualquer critério" (o "E/OU" do plano; o estágio de maior ordem com algum critério
  atendido) ou "dois ou mais" (regra da SES-MG).
- **Descer de estágio** só é sugerido depois de 4 SE completas seguidas abaixo do estágio em vigor, contadas desde o
  início do acionamento em vigor ("4 SE completas seguidas abaixo do estágio em vigor, ou volta da curva ao canal
  endêmico", Plano 2025, item 7.2.3, p. 52). O item fala em "período superior a quatro semanas" para a curva
  epidêmica: 4 SE é interpretação, e a vigilância que quiser a letra põe 5 nas semanas da desmobilização do plano. A
  descida olha a curva dos **agravos que sustentam o estágio** (S): os agravos com canal cujo critério de canal de
  algum estágio até o em vigor foi atendido:
  - no retrato do acionamento: o critério avaliado sobre as SE completas dos indicadores gravados quando a vigilância
    decidiu (`contingency_activations.indicators`), com a janela terminando na última delas. O retrato que não é
    lista, ou é lista vazia, como o do acionamento da demonstração, não conta;
  - ou numa SE completa a partir do **limite**, com a janela do critério terminando nessa SE (ela pode alcançar SE de
    antes do início). O limite é o menor entre a SE de início do acionamento em vigor e a SE seguinte à última SE
    completa do retrato; sem retrato, o início; sem acionamento, qualquer SE completa conta. O acionamento grava o
    início na SE em curso e o retrato com as SE completas do dia: com as 2 semanas incompletas do padrão (a em curso e
    a anterior), o retrato vai até duas SE antes do início. As SE entre os dois estavam incompletas quando a vigilância
    decidiu (a SE anterior à do início, no padrão; até 7 SE, com 8 semanas incompletas) e também contam. A última SE
    completa do retrato é uma só por acionamento, a maior entre os agravos do retrato (na API, a mesma em todos: a
    semana de referência do dia da decisão); o agravo do plano que não está no retrato também é olhado a partir dela,
    e a semana fora do formato AAAASS não conta. Assim, quando o critério de canal fechou numa SE ainda incompleta no
    dia da decisão (o acionamento pelo nowcasting, ou vendo a SE incompleta no diagrama), o agravo fica em S mesmo que
    a SE do acionamento seja de queda: no alerta, as SE seguintes com a curva acima do limite superior não contam como
    abaixo, e o alerta é mantido, sem o vai e volta; da epidemia, a descida para no alerta.

  A contagem das 4 SE completas da descida continua só desde o início (a nota "Só contam as SE completas desde o
  acionamento em vigor (SE XX/AAAA)" não muda). Uma SE conta como abaixo quando:
  - a sugestão dela está abaixo do estágio em vigor;
  - a curva da própria SE, em cada agravo de S, está fora dos status que os critérios de canal do estágio em vigor ou
    de um acima aceitam. No modelo do MS: no alerta, não acima do limite superior; na mobilização, até o centro ou
    abaixo do limite inferior. Uma SE de queda no meio da alta de um agravo de S não vira redução sustentada. O agravo
    fora de S não segura a descida nem o destino, e para ele vale só a sugestão de cada SE: o caso esporádico não trava
    a descida (no canal do MS de um agravo raro, como o Zika, o centro e o limite superior são zero: um caso já fica
    acima do limite superior), e a alta de um agravo cujo critério de canal ainda não fechou (3 de 4 SE acima do limite
    superior, ou em dente de serra) também não (*Pontos de atenção*);
  - nenhum agravo vigiado está sem canal nela (sem base que cubra a semana, sem população ou com o quartil
    indefinido: a curva pode não ter descido), e nenhum critério de canal de agravo vigiado, do estágio em vigor ou de
    um acima, ficou sem avaliação. Vigiados são os agravos de S e os que tiveram critério de canal sem avaliação numa
    das SE contadas (sem o dado, podem estar sustentando o estágio); com S vazio, todos os agravos com canal, para não
    descer por falta de dado. Com S vazio e o dado presente, valem só as sugestões.

  O destino da descida é o maior entre as sugestões das SE contadas, os estágios dos critérios de canal de agravos
  vigiados que ficaram sem avaliação nelas e o **piso de nível** de cada SE: o maior estágio abaixo do em vigor cujo
  critério de canal aceita o status da SE num agravo de S coberto por ele. No modelo do MS: da epidemia com a curva
  acima do limite superior, o alerta; do alerta (ou da epidemia) com a curva entre o centro e o limite superior, a
  mobilização. O agravo sem canal em nenhuma SE completa do ano anterior e do ano em análise (nunca importado,
  território sem população) não trava a contagem, porque não há como conferi-lo. Na virada do ano, as SE do ano
  anterior contam, cada uma no canal do próprio ano. O detalhe diz:
  - onde a contagem parou: "A SE XX/AAAA não conta como abaixo: a curva de <agravo> está <status>, no nível do
    critério de canal de <estágio>; descer pede a curva abaixo desse nível em cada SE." (agravo de S) ou "A SE sem
    canal (sem base que cubra a semana, sem população ou com o quartil indefinido) não conta como abaixo: a curva pode
    não ter descido.";
  - por que o destino ficou acima das sugestões: "O critério de canal de <estágio> ficou sem avaliação numa dessas SE
    (SE sem canal na janela): a descida para nele." (quando esse estágio é o próprio destino) e "Na SE SS/AAAA, a
    curva de <agravo> está <status>, no nível do critério de canal de <estágio>: a descida para nele." (a SE mais
    recente, entre as contadas, em que a curva de um agravo de S está no nível do destino). Quando os dois seguram o
    mesmo destino, saem os dois, nessa ordem.
- **Volta ao canal endêmico**: as últimas SE completas do agravo, tantas quantas as semanas da desmobilização (4 no
  modelo do MS), dentro do canal (abaixo do limite inferior, até o centro ou entre o centro e o limite superior). Uma
  SE sem canal na janela não é volta ao canal. Com a curva de volta
  ao canal, o acumulado do ano (percentuais e letalidade) deixa de segurar o estágio (item 7.2.3), e o detalhe diz o
  que segue acima do limiar.
- **Retrato do acionamento**: o critério do acumulado do ano (percentuais, letalidade e incidência acumulada) que já
  estava atendido quando o estágio em vigor foi decidido não faz o estágio subir de novo enquanto o que chegou desde o
  retrato, avaliado sozinho, não passa do limiar: Δóbitos/Δprováveis (letalidade), Δ(graves + sinais de
  alarme)/Δprováveis (percentual de graves), Δóbitos/Δ(graves + sinais de alarme) (letalidade entre os graves),
  Δóbitos em investigação/Δprováveis e Δprováveis por 100 mil habitantes, com a população de agora (incidência
  acumulada). Sem denominador novo, o critério segue conhecido. Vale só no mesmo ano do acumulado e não depende da
  curva: a saída do canal sobe pelos critérios de canal, que pedem SE seguidas (4 no modelo do MS). É o vai e volta
  depois da descida: semanas com casos novos e poucos graves ou óbitos não reabrem o acumulado; quando os novos,
  sozinhos, passam do limiar, o critério volta a contar para subir. O detalhe diz "Já atendido quando o estágio em
  vigor foi decidido, e o que chegou desde então não passa do limiar: não faz subir".
- **Conferência do plano**: a mesma na API e na tela; agravo sigiloso não entra no plano.
- **Acionamento** (tabela `contingency_activations`): estágio, justificativa (20 caracteres ou mais), ato, retrato dos
  indicadores; fecha o acionamento aberto na véspera (no próprio dia, se ele começou hoje; a migração 0031 recusa
  acionamento que termina antes de começar) e cria a lista de ações do estágio e dos anteriores ("manter e
  intensificar"), com situação, responsável e nota. O aviso diz "Estágio <nome> acionado em <território>; N ação(ões)
  no checklist.". Sem acionamento, vale a normalidade.

### Notificação de surto

- **Ficha** (tabela `outbreaks`): tipo 3 da Ficha de Notificação do Sinan Net, sem paciente: data, unidade, agravo,
  síndrome ou CID, primeiros sintomas do 1º caso, casos suspeitos ou expostos, local inicial (1 a 11) e local de
  ocorrência (campos 17 a 33); investigação (data, modo de transmissão, veículo, observações); bloco da ficha de surto
  de DTA (campos 27 a 60); encerramento com a delimitação; número do Sinan (NU_NOTIFIC, até 7 dígitos). Numeração
  interna `AAAA/NNNN`. Cada etapa é validada (manual 5.3.1).
- **Planilha de acompanhamento** (uma linha por caso): de uma notificação ou de um registro oficial, achados por busca
  própria (agravo, período e texto: número, nome, CNS ou CPF; a busca por texto é auditada), ou digitada. A mesma
  notificação ou o mesmo registro não entram duas vezes, nem em envios simultâneos. O registro oficial conciliado com
  uma notificação é o mesmo caso dela: não entra se o outro já está na planilha, sai das buscas do surto, e a lista de
  surtos de cada um mostra também os do par. Na inclusão, a recusa é 409 "O registro R é o mesmo caso da notificação
  conciliada com ele, que já está na planilha deste surto (caso N)" (ou "A notificação N é o mesmo caso do registro
  oficial conciliado com ela, …"); quando a linha que já está na planilha é sigilosa para quem inclui, a mensagem sai
  sem o "(caso N)". Na criação, o registro indicado junto com a notificação conciliada com ele recebe 409 "O registro
  R é o mesmo caso de uma das notificações indicadas (conciliada com ele): indique só um dos dois". A inclusão e a
  criação avisam quando o caso já está em outro surto aberto, pela própria origem ou pelo par: "A notificação N também
  está no surto S." (ou "…, pelo registro oficial conciliado com ela.") e "O registro R também está no surto S." (ou
  "…, pela notificação conciliada com ele."); o aviso cita a origem que entra e o número do surto, nunca o outro lado.
  Quando o outro lado é sigiloso e quem inclui não o abre, o "pelo…" sai: o surto entra no aviso como o da própria
  origem, e os avisos sem "pelo…" vêm juntos, em ordem de número, antes dos outros. Surto encerrado ou descartado não
  conta. O NU_CASO nunca é reaproveitado: é 1 + o maior número já usado nas linhas e nos eventos de inclusão e
  retirada. A inclusão e a retirada conferem, dentro da transação, que o surto continua aberto (409 SURTO_FECHADO se
  ele foi encerrado ou descartado no meio); o encerramento e o descarte esperam a inclusão ou a retirada em curso.
  Caso de agravo da lista sem notificação individual gera aviso (o surto não substitui a notificação); na categoria
  "doença da lista", aviso quando as individuais não chegam a 10% dos casos. A linha de caso sigiloso aparece só com o
  número, na planilha, na linha do tempo e no espelho, para quem não pode abrir a origem; quem pode vê-la tem a
  leitura auditada.
- **Mesmo caso em duas linhas**: a notificação numa linha e o registro conciliado com ela em outra (o vínculo veio
  depois, o dado é de antes ou houve corrida). A planilha conta o caso uma vez (`casosNaPlanilha` são as linhas menos
  os pares, e a regra dos 10% conta o par uma vez), e o espelho sai com as duas linhas. O que se mostra depende de
  quem lê:
  - quem abre as duas linhas (a vigilância municipal abre todas) vê o par: cada linha aponta o NU_CASO da outra
    (`mesmoCasoQue`), a planilha e o espelho as marcam, e o detalhe, a lista e o espelho avisam "Os casos a e b são o
    mesmo caso (notificação e registro conciliados): retire uma das linhas." (no surto encerrado: "…: digite só uma
    das linhas no Sinan Net.");
  - para quem uma das linhas, ou as duas, é sigilosa (a linha mascarada, `restrito`), o par não é revelado:
    `mesmoCasoQue` fica nulo nas duas, nenhuma é marcada, e o aviso é genérico, sem os NU_CASO, juntando todos os
    pares ocultos: "Há um caso em duas linhas da planilha (notificação e registro conciliados): quem abre as duas
    origens vê quais. Retire uma delas." (no encerrado, "… Digite só uma delas no Sinan Net."); com mais de um, "Há N
    casos com duas linhas cada na planilha (notificação e registro conciliados): quem abre as duas origens vê quais.
    Retire uma das linhas de cada um." (no encerrado, "… Digite só uma das linhas de cada um no Sinan Net."). Os
    avisos dos pares revelados vêm antes do genérico.
- **Bloco de DTA** conferido na API e na tela (número inteiro, data válida e não futura, critério de 1 a 5); no
  espelho, as datas saem em dd/mm/aaaa.
- **Prazo**: 24 h do conhecimento para a SMS (cumprido no próprio registro quando a vigilância municipal registra) e,
  com evento de saúde pública, para a SES e o MS (comunicação registrada). Linha do tempo com cada evento.
- **Espelho** com as variáveis do dicionário (TP_NOT = 3, ID_AGRAVO, DT_NOTIFIC, ID_UNIDADE, DT_SIN_PRI, QT_TOTAL_C,
  CS_LOCAL...) e a planilha como vai ao Sinan, para a digitação.
- **Sugestões** (o sistema sugere, a vigilância confirma ou dispensa com motivo): dois casos do mesmo agravo no mesmo
  quarteirão ou no mesmo bairro em 7 dias (fora dengue, chikungunya e Zika, que aparecem pelo excesso no diagrama do
  bairro ou da localidade); varicela atendida em hospital (1 caso); síndrome gripal por covid-19 na mesma unidade
  (3 casos em 7 dias); evento inusitado (primeiro caso do agravo depois de 365 dias sem casos, ou nunca visto). As
  regras padrão ficam nas configurações da instituição. Violências, agravos do trabalho e condições crônicas ou
  congênitas nunca viram sugestão. Caso já ligado a um surto (aberto, encerrado ou descartado) não volta como
  sugestão, esteja na planilha a própria notificação ou o registro oficial conciliado com ela. No evento
  inusitado, a suspeita descartada não conta como caso anterior, e os casos de outras unidades contam. O agravo com
  caso da janela já ligado a um surto, visto ou não por quem lê, fica fora do evento inusitado: o caso em surto conta
  como anterior em qualquer data, e o caso índice achado depois pela busca ativa não reabre o "primeiro caso". O caso
  sem início dos sintomas entra no dia local da instituição.
- **Dispensa** com motivo: vale até o último caso que a tela mostrou (a tela manda o instante de conhecimento dele).
  Se já há caso conhecido depois desse instante, a resposta é 409 "A sugestão mudou desde que a tela foi aberta: abra
  de novo.". A tela recarrega a lista e mantém o diálogo aberto, com o motivo digitado, apontado para a sugestão de
  mesma assinatura e com o aviso "Chegou caso novo depois de a lista carregar: confira antes de dispensar.". Se a
  sugestão saiu da lista (409 sem ela, ou 404), a tela avisa "A sugestão saiu da lista: virou surto, foi dispensada ou
  ficou sem casos. Não há o que dispensar." e fecha o diálogo. A dispensada volta quando aparece caso conhecido depois
  dela.
- **Teto e evento inusitado**: as regras de vizinhança (quarteirão, bairro e unidade, pelas regras da instituição ou
  pelas padrão) leem até 5000 notificações da janela, as mais recentes, só dos agravos que alguma regra em vigor
  alcança; quando o teto corta, o aviso cita os agravos com casos de fora. O evento inusitado é avaliado para todos os
  agravos que podem virar sugestão, dentro e fora do alcance das regras, por uma consulta agregada sobre a janela de 30
  dias. Candidato é o agravo sem caso em surto e sem histórico, ou com o último caso anterior a mais de
  `diasInusitado` dias do primeiro caso da janela que quem lê vê. As notificações dos candidatos são lidas à parte, na
  ordem da data do caso, com uma cota por agravo dentro do teto de 5000: o agravo pequeno entra inteiro, e o primeiro
  caso de cada um sempre entra (a epidemia de um agravo não tira o inusitado de outro). Quando a cota corta, o aviso
  diz "Evento inusitado: mais de 5000 notificações nos últimos 30 dias dos agravos que podem ser inusitados; de
  <agravos>, só as primeiras entraram na sugestão.". A notificação lida só para o evento inusitado fica fora das
  regras de quarteirão, bairro e unidade. O quarteirão é localizado só para as notificações das regras de vizinhança,
  em lote.
- O núcleo do estabelecimento só vê e cria surtos das unidades em que está lotado. A dispensa feita pelo núcleo só
  vale na visão dele; a da vigilância municipal vale para todos.

### Notificação negativa e unidade silenciosa

- **Unidades notificantes** (tabela `notifying_units`): períodos em que a unidade é notificante, o denominador da
  negativa. A migração abriu um período desde 01/01/2026 para cada unidade ativa, exceto farmácia central,
  almoxarifado e vigilância em saúde; unidade nova aparece "sem configuração" até a vigilância abrir o período.
- **Responsáveis** (titular e substituto, tabela `notifying_unit_responsibles`): designados pela vigilância entre os
  lotados na unidade num papel que atesta a negativa (ACS, recepção, faturamento e os papéis de endemias não atestam);
  a busca dos lotados é pelo nome ou pelo CPF completo. A palavra "atesto" não está nas normas: é o bloco "Notificante"
  da ficha (nome, função e assinatura), que o Sinan Net não guarda. No OmniSaúde, o atesto é o registro identificado
  do responsável logado, que precisa continuar lotado na unidade num papel que atesta.
- A designação só **vale** com o acesso ativo e a lotação ativa na unidade num papel que atesta. A que deixou de
  valer (acesso desativado, lotação encerrada, papel trocado) aparece com a marca "Não vale" e o motivo, e o titular
  inválido gera aviso na configuração. "Notificantes sem titular" e "Sem nenhum responsável" contam só designações
  que valem. Designar novo titular quando o atual não vale encerra a designação antiga na mesma transação (com o
  motivo na trilha); com titular válido, a nova designação de titular continua recusada.
- **Atesto** (tabela `negative_reports`, tela *Notificação negativa*): só semana terminada e dentro das últimas 8;
  texto da declaração à vista, com a citação do art. 2º, IX, do Anexo V da PRC nº 4/2017; grava nome, função, CBO,
  data e hora, o prazo usado (`deadline_at`, sempre preenchido) e se foi **fora do prazo** (padrão: segunda-feira 14h
  da semana seguinte). A configuração da negativa (semanas que se pode atestar, prazo) é lida no banco mestre na hora,
  sem o cache do catálogo. Recusado se a unidade tem na semana notificação, surto ou registro oficial (ou rascunho a
  confirmar); cai sozinho (cancelado, com a causa) quando um deles aparece depois (as regras RQ002 e RQ003 do Sinan).
  A vigilância atesta em nome da unidade com motivo e anula com motivo. Espelho em PDF, com o prazo gravado no
  atesto, e não o recalculado: "No prazo (até …)." ou "FORA DO PRAZO: o prazo era …."
- **Grade** unidade × semana: positiva, negativa, negativa atrasada, sem informação, aguardando (antes do prazo), em
  curso e fora do período, com a fonte de cada célula (notificações, surtos, registros oficiais, atesto, negativa do
  Sinan). Cartões: **unidades silenciosas** (2 semanas fechadas seguidas sem informação, padrão), **só negativas**
  (12 semanas só com negativa: pede busca ativa, como manda o manual do Sinan), percentual por semana com a meta de 80%
  e **regularidade do município** (8 SE seguidas sem nenhuma informação: PRC nº 6/2017, art. 454-E). Diferenças com o
  Sinan Net: atestado e não digitado (sem NNEGANET vigente) e digitado sem atesto. O prazo da coluna é o prazo da
  semana pela regra de agora; a célula com atesto traz o prazo gravado com ele (`fontes.atesto.prazo`, o
  `deadline_at`, que decidiu o "fora do prazo"). O detalhe da célula diz, no fuso da instituição, "CNES <cnes> · de
  dd/mm a dd/mm · prazo da semana: dd/mm/aaaa, hh:mm" e, com atesto, " · prazo do atesto: dd/mm/aaaa, hh:mm"; quando os
  dois diferem (a regra mudou depois do atesto), acrescenta "O prazo do atesto é o que valia quando ele foi feito; a
  regra do prazo mudou depois."
- A grade analisa uma janela maior que a exibida (até 60 SE), para que as contagens de silenciosa, só negativas e
  regularidade não dependam do número de colunas pedido. A regularidade usa os fatos do **município inteiro**:
  notificações de qualquer unidade (inclusive da vigilância), surtos, registros oficiais do município (pelo IBGE, pela
  unidade ou pelo CNES, mesmo fora do cadastro) e atestos. Semana sem nenhuma unidade notificante encerra a contagem
  ("A regularidade conta desde a SE..."). Epizootia e tracoma não são importados: a grade avisa para conferir no Sinan.
- **Desativar a unidade** no cadastro (o botão pede confirmação, com o aviso) faz, na mesma transação e no fuso da
  instituição:
  - o período aberto, e o encerrado com fim depois de hoje, terminam hoje, com o motivo "Unidade desativada no
    cadastro" (no encurtado, a trilha guarda o fim e o motivo anteriores);
  - o período e as designações ativas que só começariam depois de hoje são apagados, com auditoria, e o último período
    que restou fica marcado (`notifying_units.next_removed_at`; o motivo dele não muda);
  - as designações ativas terminam hoje.
  A SE da desativação ainda conta; as seguintes ficam fora da grade e das silenciosas. A designação, a abertura e o
  encerramento do período feitos ao mesmo tempo esperam e releem a unidade e os períodos, dentro da transação. As
  travas vêm nesta ordem: a da unidade notificante (`negativa-responsavel:<unidade>`), a linha da unidade (só na
  desativação), as linhas dos períodos (`FOR UPDATE`) ou das designações, as linhas da unidade e do usuário que a
  gravação pede pelas chaves estrangeiras e, por último, a trilha. A designação grava a auditoria no fim, depois da
  designação nova (primeiro a revogação do titular que não valia, depois a designação): o cadastro que troca o CNES da
  unidade, ou o CPF ou o CNS do usuário designado, ao mesmo tempo espera a designação na linha, sem impasse. O impasse
  que sobrar em outro caminho responde 409 OPERACAO_SIMULTANEA (`docs/ARQUITETURA.md`).
- **Unidade inativa com período** aberto, ou que termina depois de hoje (dado anterior a esta versão), continua na
  grade como silenciosa e no percentual, até o fim do período. A configuração e a grade avisam para encerrar o período
  na data da desativação (ex.: "Unidade inativa com período de notificante até dd/mm/aaaa, depois de hoje. Encerre o
  período na data da desativação."). Nela, o encerramento alcança também o período que termina depois de hoje (o fim
  encurta, e a trilha guarda o fim e o motivo anteriores), e o fim não passa de hoje, no fuso da instituição (422
  FIM_DEPOIS_DE_HOJE). Na unidade ativa, nada muda: só o período aberto se encerra.
- **Reativar** não reabre nada. A unidade ativa sem período aberto nem com fim depois de hoje, cujo último período
  terminou com o motivo da desativação ou cuja desativação apagou o período planejado, entra como "sem configuração",
  com o aviso "Unidade reativada: o período de notificante terminou na desativação. Abra um período novo se ela voltou
  a notificar." na lista (a grade dá o mesmo aviso, com o nome da unidade), e não é cobrada como silenciosa. Abrir um
  período novo tira a marca.
- **Prazos e parâmetros** (`PATCH /vigilancia/configuracoes`): a leitura, a mescla e a gravação ficam numa transação
  do banco mestre, com a linha da instituição travada: salvamentos simultâneos de campos diferentes não se perdem, e
  a trilha bate com o gravado. A tela lê as configurações no banco mestre (`GET /vigilancia/configuracoes`, sem o
  cache do catálogo) e mostra o valor salvo logo depois de salvar, mesmo quando a leitura vem de outra instância da
  API. As telas da grade e do responsável, numa instância que não salvou, podem usar a configuração em cache por até
  60 s. A gestão da vigilância (aba Plantão e contatos) tem um atalho para essa seção.
- A importação casa o atesto com a negativa do NNEGANET (mesma unidade pelo CNES e mesma SE); se a negativa sai do
  Sinan, o atesto volta a "atestado e não digitado". A tarefa `vigilancia` (a cada 5 minutos) reconcilia os atestos,
  expira as prévias e roda a conciliação automática.

### Perfis (semana 27)

| Permissão | Quem |
|---|---|
| `vigilancia.importar` (importar e conciliar; listas identificadas, inclusive as candidatas ao vínculo) | vigilância municipal |
| `vigilancia.consolidacao` (receitas, população, congelar canal, unidades notificantes, responsáveis, anular atesto, atestar em nome da unidade) | vigilância municipal |
| `vigilancia.contingencia` (critérios manuais, plano, acionamento, ações) | vigilância municipal |
| `vigilancia.surto` (sugestões e notificações de surto) | vigilância municipal; núcleo do estabelecimento, só das suas unidades |
| `notificacao.negativa` (tela do atesto; a ação exige designação) | todo papel com `notificacao.registrar`, o gestor e as vigilâncias |
| `vigilancia.catalogo` (prazos e parâmetros da negativa, da consolidação e do evento inusitado) | vigilância municipal |
| leitura do diagrama, da contingência e da grade | `vigilancia.resumo` (gestor) ou `vigilancia.painel`; agravo sigiloso no diagrama, só a vigilância epidemiológica municipal |

### Telas (semana 27)

- **Consolidação e surtos** (`/vigilancia/consolidacao`), com abas por permissão: *Importação* (envio, prévia,
  codificação, aplicar, descartar, histórico; a dica da aba Ausentes da prévia diz "Registros que estão no banco e não
  vieram, dentro do que cada arquivo do envio cobre: o sistema, o tipo, os agravos e o período dele e, no e-SUS, o
  estabelecimento do arquivo de um CNES só. Ao aplicar, ficam marcados como ausentes (não são apagados)."; a
  importação substituída aparece como "Substituída", e o detalhe mostra o envio que a substituiu e quando),
  *Conciliação* (resumo, listas, vinculados, vincular, desvincular, rejeitar, apelidos de bairro; o "Vincular…" do
  registro busca nas candidatas ao vínculo), *Diagrama de controle* (agravo, território, ano, eixo; gráfico com a
  faixa do canal, a mediana, o limite superior e a curva observada; tabela com os mesmos números; receita, população,
  anos epidêmicos, congelar e CSV), *Contingência* (estágio em vigor, sugestão com cada critério, últimas semanas no
  canal com o texto de cada selo, respostas da semana, acionamento, plano e lista de ações), *Surtos* (sugestões com a
  unidade do excesso, lista, ficha, planilha com busca de notificação e de registro oficial, espelho; o cabeçalho
  "Casos (informados / na planilha)", a aba "Planilha de casos (N)", o título da planilha e a lista contam o caso em
  duas linhas uma vez, pelo `casosNaPlanilha`; as duas linhas do par que quem lê vê vêm marcadas com "Mesmo caso do
  caso N", na planilha e no espelho, e o par com linha mascarada não é marcado) e *Notificação negativa* (grade,
  cartões, configuração das unidades notificantes e dos responsáveis, e *Prazos e parâmetros*; o detalhe da célula
  mostra o prazo da semana e o prazo do atesto).
- Os horários das telas da semana saem no fuso da instituição. O seletor de agravo esconde os sigilosos de quem não
  pode vê-los. Cada lista de abas tem nome próprio para o leitor de tela, e os botões que se repetem em cada linha
  dizem o objeto:
  - "Vincular o registro N" e "Desvincular o registro N";
  - "Revogar a designação de <pessoa> como responsável da unidade <unidade>", "Designar responsável da unidade
    <unidade>", "Encerrar o período da unidade <unidade>" e "Tornar <unidade> notificante" (unidades notificantes);
  - "Editar <nome>", "Desativar <nome>" e "Reativar <nome>" (cadastro de unidades, só com o nome: duas unidades de
    mesmo nome repetem esses botões).

  Nas telas da negativa (grade, unidades notificantes e tela do responsável), <unidade> é o nome da unidade. Quando
  outra unidade da mesma tela tem o mesmo nome (o nome não é único, só o CNES é), vai o nome com o CNES: "Posto de
  Saúde (CNES 9100001)". Maiúsculas, acentos e espaços repetidos não distinguem os nomes, e conta a lista inteira da
  tela: o nome não muda com o filtro nem com a busca. O mesmo nome vai no rótulo da célula da grade ("<unidade>, SE
  SS/AAAA: <situação>. <fontes>."), nos cartões das unidades silenciosas e das só negativas, e no título e na mensagem
  dos diálogos das unidades notificantes.

  Na tela do responsável, "Atestar a SE SS/AAAA" e "Espelho em PDF da SE SS/AAAA" com uma unidade só, e "Atestar a SE
  SS/AAAA, <unidade>" e "Espelho em PDF da SE SS/AAAA, <unidade>" com mais de uma; no histórico, que junta as
  unidades, "Espelho em PDF da SE SS/AAAA, <unidade>" (o CNES entra também quando a unidade do histórico tem o nome de
  outra unidade da tela). O PDF do atesto que não é o vigente leva também a situação e quando foi atestado, com os
  segundos, no fuso da instituição: "Espelho em PDF da SE SS/AAAA, <unidade>, anulada, atestada em dd/mm/aaaa,
  hh:mm:ss" (ou "…, cancelada, …"). Assim ficam distintos o anulado e o refeito da mesma SE e unidade, e também dois
  anulados do mesmo minuto. Se dois atestos diferentes ainda ficarem com o mesmo nome (não vigentes da mesma SE,
  unidade e situação, atestados no mesmo segundo), cada um leva a sua ordem pela hora do atesto: "… (1 de 2)", "… (2
  de 2)". Com mais de uma unidade, o mesmo atesto na semana e no histórico tem o mesmo nome (é o mesmo espelho).
- *Desativar* no cadastro de unidades pede confirmação: "Encerra hoje o período de unidade notificante e as
  designações de responsável pela notificação negativa (o que só começaria depois de hoje é apagado); reativar não os
  reabre.". Reativar é direto, com o aviso de que a negativa não se reabre.
- *Encerrar período* na unidade inativa limita a data a hoje e aparece também para o período que termina depois de
  hoje.
- A aba *Notificação negativa* abre direto numa seção pelo endereço (`?aba=negativa&secao=unidades|parametros`), se a
  pessoa pode vê-la; a gestão da vigilância usa isso no atalho para *Prazos e parâmetros*.
- Envio cuja resposta se perdeu (0, 502, 503, 504 ou 524) aparece como aviso, "A resposta do envio não chegou", e não
  como erro. Em qualquer tela, uma página HTML de erro da borda (ou um corpo vazio ou longo) não vira mensagem. Para
  502, 503, 504 e 524, a mensagem é "O servidor demorou a responder. Tente de novo em instantes."; nos demais casos,
  "Erro N". O 413 do proxy, sem JSON, vira "O arquivo passa do tamanho aceito pelo servidor. Exporte um período menor
  ou separe o arquivo."; o 413 da API mantém a mensagem dela.
- No envio e no aplicar, o 409 IMPORTACAO_OCUPADA mostra o texto da tela, que manda acompanhar no histórico ("Outra
  importação está sendo lida ou aplicada agora (uma por vez). Acompanhe no histórico e tente de novo quando ela
  terminar."); o IMPORTACAO_SERVIDOR_OCUPADO mostra a mensagem da API, porque o outro envio pode ser de outro
  município, que não aparece no histórico.
- **Notificação negativa** (`/notificacao-negativa`): as unidades do responsável, as semanas a atestar com o texto à
  vista, o botão *Atestar*, o histórico e o PDF.

### API (semana 27)

`/api/vigilancia/...`: `importacoes` (POST com o arquivo cru e `?nome=&de=&ate=&codificacao=`: 201 com a prévia, 202
enquanto lê, 200 com `jaImportado` para o arquivo já aplicado; antes de ler o corpo, 400 VALIDACAO (o nome com
caractere de controle, inclusive), 415 FORMATO, 413 ARQUIVO_GRANDE, 400 PERIODO_INVALIDO ou 409 IMPORTACAO_OCUPADA ou
IMPORTACAO_SERVIDOR_OCUPADO; no meio do corpo, 408 ENVIO_PARADO ou 400 ENVIO_INCOMPLETO; depois dele, 409
IMPORTACAO_SERVIDOR_OCUPADO se outro município tomou a vez; GET), `importacoes/:id` (GET; `?acompanhar=1` vem sem a
prévia e sem auditoria; na SUBSTITUIDA, `substituidaPor`; o `resultadoAplicacao` vem sem a cobertura gravada),
`.../aplicar` (200 ou 202 enquanto aplica; 409 na SUBSTITUIDA), `.../descartar` (409 na SUBSTITUIDA);
`conciliacao/resumo`, `/so-oficial`, `/so-omnisaude`, `/divergentes`, `/sugestoes`, `/vinculados`, `/candidatas`
(`?sistema=&grupo=&de=&ate=&busca=&pagina=`, 50 por página, auditada como a lista "candidatas"; a busca com caractere
de controle dá 400 VALIDACAO), `/bairros?pagina=`, `/vincular` (409 CASO_DUPLICADO_NO_SURTO), `/desvincular`,
`/rejeitar` (os três podem responder 409 CONCILIACAO_OCUPADA), `/bairros/apelido` (400 com o nome com caractere de
controle); `populacao` (GET, PUT), `populacao/:id` (DELETE); `diagrama`, `diagrama.csv`, `diagrama/congelar`,
`diagrama/configuracao/:grupo` (GET, PUT; agravo sigiloso: 403 AGRAVO_SIGILOSO fora da vigilância epidemiológica),
`diagrama/anos-epidemicos`; `contingencia`, `contingencia/planos` (GET, POST), `contingencia/planos/:id` (GET, PUT;
409 fora do rascunho), `.../vigencia` (409 CONFLITO no plano já em vigor; 422 VIGENCIA_INVALIDA antes do vigente),
`contingencia/respostas`, `contingencia/acionar`, `contingencia/acoes/:id` (PATCH); `surtos` (GET, POST),
`surtos/sugestoes`, `surtos/sugestoes/dispensar` (`{ assinatura, motivo, ultimoConhecimento }`; 409 quando a sugestão
mudou; 404 quando ela saiu da lista), `surtos/candidatas`, `surtos/registros`, `surtos/:id` (GET, PATCH), `.../casos`
(POST), `.../casos/:caseId` (DELETE), `.../comunicacoes`, `.../encerrar`, `.../descartar`, `.../numero-oficial`,
`.../espelho`; `negativas` (POST), `negativas/minhas`, `negativas/grade?semanas=&ate=` (a célula com atesto traz
`fontes.atesto.prazo`, o prazo gravado com ele), `negativas/:id/espelho.pdf`, `negativas/:id/anular`;
`unidades-notificantes` (GET, POST), `unidades-notificantes/:unitId/encerrar` (na unidade inativa, 422
FIM_DEPOIS_DE_HOJE), `.../responsaveis` (cada responsável com `valido` e `motivoInvalido`; o POST de titular troca o
titular que não vale), `.../lotados?busca=`, `responsaveis/:id/revogar`; `configuracoes` (GET, lido no banco mestre;
PATCH, agora também com os blocos `negativa`, `consolidacao` e `surto.diasInusitado`, campo a campo, numa transação
com a linha travada). Em qualquer rota, o impasse ou a falha de serialização do banco responde 409
OPERACAO_SIMULTANEA, e o texto com o caractere nulo que chega ao banco, 400 VALIDACAO (`docs/ARQUITETURA.md`).

### Demonstração

A carga de desenvolvimento (`node packages/database/dist/cli.js seed`, que também cria a malha da sede) semeia a
semana 27 com datas relativas ao dia em que roda (os testes da API não a carregam). Como o resto da carga, só roda
num tenant de demonstração vazio: o já populado é pulado inteiro (para ver a semana 27, recrie o banco do tenant
`demo`). Tudo é sintético: nenhum registro corresponde a pessoa real.

- **População**: RIPSA de São Paulo (355030, o IBGE do tenant de demonstração) de 2016 a 2025, consultada no TabNet
  (popsvs, versão 2000-2025); Censo 2022 do município (11.451.999, SIDRA, tabela 4709); Censo 2022 **sintético** da
  localidade Sede e do bairro Centro. O ano em análise usa a de 2025, marcada "repetida".
- **Importação APLICADA** "Demonstração (dados sintéticos)": DENGON de 7 anos (o penúltimo epidêmico, 2024 quando o
  ano em análise é 2026), CHIKON menor e NNEGANET com as negativas digitadas. No ano em análise, a dengue fica acima da
  mediana e abaixo do limite superior nas 6 últimas semanas completas: a contingência sugere **mobilização**. Excluir
  2024 da referência (na receita, com o motivo) põe a curva acima do limite superior: a sugestão sobe para **alerta**.
- **Receita** MS 2025 para a dengue com a RIPSA; **plano** modelo do MS em vigor desde o início do ano epidemiológico,
  com acionamento **normalidade** e a lista de ações; dois critérios manuais respondidos na semana de referência.
- **Notificações de dengue**: duas casadas com o registro oficial pelo número (Maria, com divergência de situação,
  evolução e encerramento; José, sem divergência), duas só no OmniSaúde (Carlos e Juliana) e uma com **sugestão de
  vínculo** por nome, nascimento e sexo (Thiago). Registros com bairros "JD DAS FLORES" e "VL NOVA" aparecem em
  *bairros sem correspondência* para virar apelido do Centro.
- **Surto de DTA** aberto numa escola da malha (14 expostos, 6 linhas na planilha, investigação e bloco de DTA) e duas
  **coqueluches** no bairro Centro na mesma semana: sugestão de surto pelo bairro e de evento inusitado.
- **Negativa**: unidades notificantes, responsáveis (UBS Centro: Bruno, titular, e Íris, substituta; UPA 24h Norte:
  Bruno; Hospital Municipal São Lucas: Nelson; Policlínica: Fábio; CEO Sorriso: Diego) e atestos das últimas 16
  semanas, um fora do prazo. A **UBS Jardim das Flores**, sem responsável, fica sem informação nas 3 últimas semanas
  fechadas: a unidade silenciosa. O CEO só manda negativas. A Policlínica não atestou a última semana (Fábio pode
  atestar na tela) e tem uma negativa só digitada no Sinan.

Senha `OmniSaude2026`, instituição `demo`: vigilância epidemiológica 100.000.014-14; NIR (Policlínica) 100.000.006-04;
núcleo hospitalar 100.000.015-03; enfermeiro (UBS Centro e UPA) 100.000.002-80; gestora 100.000.009-57.

### Como foi verificado

- Regras compartilhadas (`packages/shared/test/vigilancia-*.test.ts`): tabela de agravos do Sinan, chaves naturais,
  funções do Excel e exemplos publicados do diagrama, avaliação do plano, regras de surto e grade da negativa.
- API contra PostgreSQL real (`apps/api/test/vigilancia-importacao.test.ts`, `-diagrama`, `-contingencia`, `-surto`,
  `-negativa` e `migracao-0031.test.ts`).
- Correções das revisões adversariais, cada uma com teste de regressão que falha no código anterior: importação em
  segundo plano, travas e memória (`vigilancia-importacao-r3*.test.ts`, `-r4*.test.ts`, `-r5*.test.ts` e
  `-r6*.test.ts`, com a API num processo filho limitado a 512 MB; corpo cru, cobertura dos ausentes por arquivo,
  substituição do mesmo arquivo com a ausência confirmada por outra aplicação, a vez de outro município e a carga da
  SIGTAP antes do corpo, busca com caractere de controle; a prévia igual à aplicação com registros sem CNES, sem
  município, sem agravo e sem ficha, também em 150 arranjos sorteados no serviço e 40 pela API; a cobertura da base
  consolidada e da conciliação lida do `apply_result`; o caractere de controle limpo na leitura), conciliação
  (`vigilancia-conciliacao-travas`, `-cobertura`, `-regras`, `-r4`, `-pool`, `-divergencias` e `-bairros`), base
  consolidada (`vigilancia-consolidado-cobertura`), contingência (`vigilancia-contingencia-r3`, `-r4`, `-r5` e `-r6`,
  na API e em `packages/shared/test`: a descida pelos agravos que sustentam o estágio, o piso de nível e a SE que
  estava incompleta no acionamento), quarteirões em lote (`vigilancia-diagrama-quarteiroes`, `vigilancia-mapa-lote` e
  `territorio-quarteiroes-lote`), surto (`vigilancia-surto-r3`, `-r4` e `-r5`: o par sem revelar a linha sigilosa),
  negativa (`vigilancia-negativa-r3`, `-r4` e `-r5`: o prazo gravado na grade e a designação sem impasse com o
  cadastro) e o filtro global de erros (`filtro-erros-r5`: impasse e serialização em 409, o caractere nulo em 400, com
  os erros reais do Prisma 7), além dos testes das telas em `apps/web/test` (`surto-r5`, `negativa-r5` e
  `negativa-r6`: a contagem do detalhe do surto, as marcas do par e os nomes acessíveis da negativa, também com
  unidades de mesmo nome e com atestos do mesmo minuto ou do mesmo segundo).
- Demonstração: `packages/database/test/seed-consolidacao.test.ts` refaz a sugestão do plano só com as funções
  compartilhadas em seis datas de 2026 (mobilização; alerta com 2024 excluído) e
  `apps/api/test/demo-consolidacao.test.ts` semeia a demonstração num dia fixo e confere pela API a sugestão de
  mobilização, o diagrama, a unidade silenciosa, o "só negativas", o surto de DTA, a sugestão de surto e as listas da
  conciliação; rodar a carga duas vezes não duplica (o tenant já populado é pulado).

### Pontos de atenção (semana 27)

- **DBC do DATASUS** (compressão implode) não é lido: as bases públicas são anonimizadas e não servem para conciliar.
  Vale a exportação do Sinan Net (DBF) e do Sinan Online.
- **Sivep-Gripe e ESAVI** não são importados nesta semana.
- **Nowcasting** não é calculado: os critérios de nowcasting ficam manuais (InfoDengue).
- **Sinais de surto por atendimento** (síndromes nos atendimentos sem notificação) ficam fora: as sugestões olham só
  as notificações e o diagrama.
- **Consórcio com vários municípios**: o nível município usa o IBGE do tenant.
- **População de bairro** pela proporção do Censo 2022 é inferência a validar; o Censo por bairro só existe para
  bairro legalmente instituído (no Tocantins, a soma por setor censitário).
- **Unidade silenciosa** (2 semanas) e **só negativas** (12 semanas) são escolhas locais: não há definição federal.
- **Epizootia e tracoma** (art. 454-B, III e IV) não são importados: a regularidade do município não os lê, e a grade
  avisa para conferir no Sinan. Semana sem nenhuma unidade notificante encerra a contagem da regularidade, mesmo que
  uma importação cubra o período (regra conservadora).
- **Evento inusitado**: os registros oficiais da janela sem notificação conciliada não contam como caso anterior, só
  os anteriores a ela (contar o mesmo caso digitado no Sinan e ainda não conciliado apagaria um inusitado verdadeiro).
  Se o município já tem no Sinan, na janela, um registro de um agravo que o OmniSaúde nunca viu, a primeira notificação
  dele ainda vira "Primeiro caso do agravo registrado no município".
- **Cobertura por data**: a notificação feita no dia do primeiro envio do arquivo, mesmo depois dele, ainda entra em
  "só no OmniSaúde", porque o arquivo cobre o dia inteiro.
- O 409 de **conciliação ocupada** aparece com uma importação sendo aplicada e também quando o vínculo automático da
  tarefa periódica segura a trava por mais de 3 s, o que só deve acontecer numa base grande. No vínculo que preenche
  o número oficial, se uma importação começa entre a conferência da trava e a gravação, o número fica preenchido e o
  vínculo responde 409; a próxima rodada da tarefa liga o par pelo número.
- **Mesmo caso em duas linhas do surto**: o vínculo automático não pega as travas dos surtos (segurá-las durante a
  aplicação travaria as inclusões por minutos) e confere o par só na gravação, e a criação do surto confere o par
  antes da transação. Numa corrida, a notificação e o registro conciliado com ela podem ficar em duas linhas do mesmo
  surto aberto: o aviso e a contagem uma vez cobrem o resultado, e a vigilância retira uma das linhas. Para quem não
  abre uma das linhas, o aviso é genérico e as linhas não são marcadas, mas a contagem (`casosNaPlanilha`) e o aviso
  dizem que há um par: numa planilha pequena (duas linhas, uma mascarada), quem lê deduz qual é. As buscas do surto
  também tiram a notificação ou o registro cujo outro lado já está na planilha, o que indica que o caso está lá, sem
  dizer a linha.
- **Envio interrompido no meio**: o 408 e o 413 que saem com o corpo pela metade fecham a conexão com o cliente ainda
  mandando; algum navegador vê a conexão cortada em vez da mensagem, e a tela mostra "A resposta do envio não chegou".
- **Primeiro envio que falha dentro da espera**: a leitura que falha antes da resposta apaga a linha do envio, que
  então não conta como primeiro envio do arquivo. Reenviado dias depois, com um período declarado além da data da
  exportação, o arquivo tem a cobertura limitada pela data do reenvio, e não pela do envio que falhou: o que foi
  notificado entre as duas datas pode ficar ausente. Exige a falha dentro da espera, o reenvio em outro dia e o
  período declarado além da exportação; a falha depois do 202 fica no histórico (FALHOU) e conta.
- **Arquivo antigo dentro de um zip novo**: o fim da cobertura no primeiro envio é procurado pelo SHA-256 do envio, e
  não pelo de cada arquivo do zip. A exportação antiga já enviada sozinha e reenviada dentro de um zip novo, com um
  período declarado além da data dela, fica com o fim no primeiro envio do zip: o que foi notificado depois da
  exportação, e não veio nela, fica ausente, o que não acontece com o mesmo arquivo reenviado sozinho. É a exceção à
  regra de que os mesmos arquivos dão o mesmo resultado num zip ou em envios separados, e vale também para o "só no
  OmniSaúde" e para a base consolidada. Exige o reenvio dentro de um zip com o período declarado além da exportação;
  para declarar o período de um arquivo já enviado, reenvie-o sozinho.
- **Série histórica de antes do Sinan Online**: na base consolidada e na conciliação, o arquivo cobre só pelas linhas
  do sistema dele, e a dengue e a chikungunya (A90 e A92.0) são sempre do Sinan Online. O NINDINET e o DBF do agravo
  do Sinan Net, também os de antes do Sinan Online, não cobrem a dengue: sem o DENGON (ou o CHIKON) do ano, o ano
  fica coberto só nas SE com caso do agravo, que o põem na lista dos anos de referência, e as SE sem caso ficam fora do
  canal (nulas, e não zero). A aplicação gravada antes desta regra (sem o tipo do arquivo na cobertura) ainda é lida
  pelo `files[]`, e nela o NINDINET com linhas de dengue cobre a dengue no período dele.
- **Zip com muitos arquivos de unidade** (até 1.000) com períodos diferentes vira até 1.000 entradas de cobertura:
  uma consulta por entrada na prévia e na marcação dos ausentes, e a prévia exclui de cada entrada o que as anteriores
  que se cruzam com ela já contaram. Na substituição do mesmo arquivo com ausentes, as outras aplicações são lidas com
  o resultado inteiro. O tempo desse caso não foi medido.
- **Pacote da SIGTAP e importação da vigilância** dividem as cargas do processo (1 arquivo por município, 2 no
  processo): os dois envios do mesmo município não correm ao mesmo tempo, e o segundo recebe 409.
- **Mais de 200 quarteirões candidatos por ponto**: a localização fica com os 200 primeiros pela área e pelo id, e um
  quarteirão grande que contém o ponto pode ficar de fora (`docs/TERRITORIO.md`).
- **Configuração em cache**: as telas da grade e do responsável, numa instância da API que não salvou, podem usar a
  configuração da instituição em cache por até 60 s; o atesto e a tela de parâmetros leem o banco mestre.
- **Memória do Prisma**: o cliente do Prisma 7 guarda os argumentos das últimas 100 chamadas internas, mesmo sem
  `DEBUG`. A importação e o vínculo automático gravam por SQL próprio para não reter as linhas; o vínculo automático
  ainda lê os pares por `findMany` com até 5.000 ids por consulta, e as outras cargas grandes (CNES, demonstração)
  ainda serão medidas.
- **Ocupação de leitos** não é critério de estágio no plano do MS (só aparece nas ações).
- O código das síndromes do surto vem de fonte secundária: conferir no Sinan Net antes de digitar.
- As **regras das sugestões de surto** (janelas e número de casos) não têm tela: valem os padrões das configurações.
  Só os dias do evento inusitado são editáveis, em *Prazos e parâmetros*.
- **Desmobilização em 4 SE**: o item 7.2.3 do plano fala em "período superior a quatro semanas" para a curva
  epidêmica. O modelo usa 4 (interpretação); 5 segue a letra e é só mudar as semanas da desmobilização no plano.
- **Agravos que sustentam o estágio**: no acionamento sem retrato (o da demonstração grava `indicators: []`) e sem
  critério de canal atendido desde o início, com o dado presente, valem só as sugestões, e a curva não segura a
  descida. O acionamento feito pela tela grava o retrato até a última SE completa do dia, e as SE completas depois
  dele, incompletas na decisão, também contam para S. A última SE completa do retrato é uma só por acionamento: o
  agravo que entrou no plano depois do acionamento, fora do retrato, também é olhado a partir da SE seguinte a ela. O
  retrato é avaliado com os critérios do plano em vigor, não com os da versão do plano do acionamento. Na combinação
  "dois ou mais", os agravos que sustentam e o piso de nível usam o critério de canal sozinho, como a condição da
  curva.
- **Agravo fora de S em alta**: a condição da curva e o piso de nível valem só para os agravos de S. O agravo cujo
  critério de canal não foi atendido no retrato nem desde o limite, mesmo com a curva alta (a chikungunya acima do
  limite superior em 3 das 4 SE contadas, o Zika entre o centro e o limite superior na mobilização, ou a curva em
  dente de serra, que quebra as janelas do critério), não segura a descida nem o destino: o plano pode sugerir
  "pode desmobilizar para Normalidade" com essa curva e, quando o critério dele fechar, sugerir subir de novo na SE
  seguinte. É a regra decidida (para o agravo fora de S vale a sugestão de cada SE); uma regra mais conservadora,
  como segurar com o critério atendido em k−1 de n SE, fica para validar com a vigilância.
- **Sigilo no diagrama**: tuberculose, hanseníase e hepatites são sigilosas só no diagrama e na contingência (Lei
  14.289/2022). Nas notificações, na conciliação, no surto e no mapa de casos, vale a marca do catálogo, que a
  instituição decide.
- **Dispensa de sugestão de surto** vale pelo instante de conhecimento: um caso digitado depois, mas com conhecimento
  retroativo até o último caso mostrado, fica coberto pela dispensa.
- **Teto das sugestões**: os agravos candidatos ao evento inusitado dividem o teto de 5000 notificações em cotas; o
  agravo com mais casos do que a cota entra com os primeiros pela data do caso, com aviso.

## Pendências e limites

- **Acordo com a SES**: quem digita em cada sistema e o destino da caxumba (marcada "a definir"); contas dos
  digitadores em cada sistema oficial.
- **Números oficiais**: o formato do Sinan Online não está em documento nacional; o do e-SUS Notifica está (DATASUS),
  mas a validação segue larga porque há fichas sem formato documentado. Ajustar com os primeiros números reais.
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
