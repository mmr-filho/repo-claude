# Vigilância em saúde: notificação compulsória (VIG-1a)

Entrega da semana 23 do cronograma (primeira da onda 4).

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

Numeração interna `AAAA/NNNNNN` (não é o número do Sinan, que chega na semana 24).

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

## Pendências e limites

- O registro no Sinan e nos demais sistemas oficiais é a semana 24 (fila de digitação e número oficial).
- O de-para de códigos precisa da homologação de um técnico da vigilância; até lá os rascunhos trazem o aviso.
- O modelo `vigilancia_alerta` precisa ser aprovado na conta do WhatsApp para o escalonamento por mensagem.
- Contatos da vigilância municipal e do CIEVS estadual, escala de plantão e lista complementar estadual ou
  municipal (se houver) dependem da instituição.
- O marco do prazo na internação (conhecimento, e não a admissão) é decisão a validar com a vigilância.
