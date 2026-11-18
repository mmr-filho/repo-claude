# Arquitetura do OmniSaúde

Este documento explica as decisões de arquitetura e onde cada parte da especificação está implementada.

## Visão geral

```
                 ┌──────────────── Web (Next.js 16) ────────────────┐
 Navegador  ───► │ telas por papel · Socket.IO · VLibras · WebRTC     │ ◄── App Android (Capacitor 8)
                 └──────────────────────────┬────────────────────────┘       mesmo front-end exportado
                                            │ HTTPS (Bearer) + WebSocket       + câmera, leitor ML Kit,
                                            ▼                                  ditado e voz nativos
 ┌────────────────────────────── API (NestJS 11) ──────────────────────────────┐
 │ guarda global (nega por padrão) → contexto Tenant + Unidade + Papel          │
 │ módulos: pacientes · agenda · recepção · triagem · clínico · farmácia ·      │
 │ leitos · POPs · faturamento · BI · gestão · serviço social · integrações ·   │
 │ acessibilidade · plataforma                                                  │
 │ trilha de auditoria SHA-256 encadeada · outbox RNDS · eventos em tempo real  │
 └──────┬──────────────────┬──────────────────────┬─────────────────┬──────────┘
        │                  │                      │                 │
  master_auth_db     tenant_db_<id> (OLTP)   tenant_db_<id>     Redis + BullMQ ── worker
  (roteamento,       um banco por tenant     _readonly           (WhatsApp, RNDS, SIGTAP)
   licenças,         prontuário único        réplica: BI e
   integrações)      da rede                 Text-to-SQL
```

## Multitenancy: um banco por contratante

- **`master_auth_db`** (`packages/database/prisma/master/schema.prisma`): tenants, licenças, integrações
  (configuração + referência ao segredo) e o **catálogo de roteamento** (`tenant_databases`: host do
  primário, host da réplica, nome do banco, conjunto de credenciais). Senhas de banco não ficam no
  catálogo: `credentialsRef` aponta para variáveis do cofre/ambiente.
- **`tenant_db_<slug>`** (`prisma/tenant/schema.prisma`, 130 tabelas): todos os dados assistenciais,
  operacionais e de faturamento do contratante. Cada banco tem backup, restauração e expurgo próprios.
- **Réplica de leitura** (`tenant_db_<slug>_readonly` no catálogo): a mesma base replicada por streaming.
  O BI e o Text-to-SQL só usam a réplica, com o papel `omni_bi_reader` (grupo `omni_bi`), que enxerga
  apenas as views do schema `bi`. O pool define `search_path=bi`, `default_transaction_read_only=on` e
  `statement_timeout`.
- **Roteamento dinâmico** (`packages/database/src/tenancy.ts`): `TenantConnectionManager` resolve o tenant
  no catálogo (cache de 60 s por instância, pelo slug e pelo id), abre um `PrismaClient` com o adaptador `pg` por
  banco (LRU com limite de tenants abertos) e confere o status a cada uso: um tenant suspenso perde o acesso mesmo
  com conexões abertas. `invalidate()` sobe um contador de geração, e cada chave guarda a geração da última
  invalidação: a leitura do catálogo que atravessou uma invalidação da chave lida, da outra chave (slug ou id) ou do
  catálogo inteiro devolve a quem pediu o que leu, mas não vai para o cache. O que vira dado durável a partir das
  configurações (o atesto da notificação negativa) e a tela de parâmetros da vigilância leem o banco mestre na hora;
  as outras leituras usam o cache.
- **Configurações do tenant** (`tenants.settings`, no mestre): a plataforma (`PATCH /platform/tenants/:id`) e a
  vigilância (`PATCH /vigilancia/configuracoes`) leem, mesclam o que veio sobre o que leram e gravam numa transação
  do mestre, com a linha do tenant travada (`SELECT … FOR UPDATE`); a auditoria da plataforma vai na mesma
  transação. A política de MFA grava só a chave dela, num UPDATE atômico (`jsonb_set`). Salvamentos simultâneos
  entram em fila e não se perdem; depois da gravação, o cache do catálogo é invalidado pelo slug e pelo id.
- **Prontuário único na rede**: unidades (UBS, UPA, hospital, policlínica, CEO, farmácia central,
  almoxarifado) são linhas do mesmo banco; a linha do tempo do paciente (`GET /patients/:id/timeline`)
  junta atendimentos, prescrições, dispensações, exames, vacinas e agendamentos de todas as unidades.
- **Migrações**: SQL versionado gerado pelo Prisma (`0001_init`) mais scripts manuais
  (`0002_bi_e_auditoria`). O executor próprio (`src/migrate.ts`) aplica o pendente em cada banco com
  advisory lock e confere o checksum (migração aplicada não pode mudar). `cli.js migrate` percorre todos os
  tenants; `tenant:create` provisiona um banco novo.

## Segurança, acesso e auditoria

- **Login por etapas** (`apps/api/src/modules/auth`): instituição + CPF + senha (scrypt nativo), 2FA TOTP
  opcional (segredo cifrado com AES-256-GCM), e escolha do **contexto ativo** (unidade + papel). O token de
  acesso carrega `tid`, unidade, papel e CBO; o banco aberto vem sempre do token, nunca do cliente. Conta
  bloqueada por 15 min após 5 senhas erradas.
- **RBAC híbrido** (`packages/shared/src/roles.ts`): 15 papéis × 87 permissões. A guarda global nega por
  padrão: toda rota declara `@Public`, `@Authenticated` ou `@RequirePermission`. A troca de unidade/papel
  emite um novo token sem novo login.
- **Trilha de auditoria imutável** (`packages/database/src/audit.ts`): cada registro clínico ou ação
  relevante gera uma entrada com `hash = SHA-256(hash anterior | SHA-256 do conteúdo canônico | instante UTC |
  IP | operador | 2FA | ação | entidade)`. Um advisory lock transacional mantém a cadeia linear; gatilhos no
  banco bloqueiam UPDATE/DELETE/TRUNCATE da trilha e qualquer alteração de nota clínica já assinada.
  `GET /audit/verify` recalcula a cadeia e aponta a primeira entrada adulterada.
- **LGPD**: visualização de prontuário, de documentos e consultas de BI ficam registradas; o BI não expõe
  CPF, telefone nem endereço; recursos que enviam dados pessoais a um provedor de IA (OCR de documento,
  ditado estruturado) só funcionam com `aiEnabled` no tenant.
- **POPs** (`modules/pops`): *hard gates* com checklist obrigatório e dupla checagem por credencial de outro
  profissional (alta vigilância, hemoderivados, antimicrobianos restritos), consumidos uma única vez pela
  administração; *soft gates* com leitura auditada.

## Fluxos clínicos

- **Recepção** (`modules/reception`, `modules/integrations/documents.service.ts`): OCR do documento (modelo
  multimodal ou texto lido no aparelho) com validação dos dígitos de CPF/CNS, cruzamento com o CADSUS (via
  RNDS) e com a base local (duplicidade por CPF/CNS ou nome + nascimento), senhas diárias com prioridade
  legal, painel de chamada por Socket.IO com texto para síntese de voz, pulseira com QR.
- **ACCR** (`modules/triage`): sinais vitais, mapa topográfico da dor (frente/costas, 0–10), discriminadores,
  sugestão de cor (`suggestRiskColor`) e justificativa obrigatória quando a enfermagem classifica abaixo do
  sugerido; fila ordenada por cor e chegada com tempo-alvo por cor (sobrescrevível por tenant).
- **Prontuário** (`modules/clinical`): SOAP/evolução/odontograma em rascunho → assinatura (hash na trilha,
  produção BPA na atenção especializada, RAC no outbox da RNDS); prescrição com o copiloto clínico
  (`@omnisaude/ai-engine`: interações, alergia cruzada, função renal por CKD-EPI 2021, potássio, gestação,
  duplicidade, dose máxima) e justificativa obrigatória para alerta GRAVE; linhas de cuidado por CID-10/
  CIAP-2 com exames SIGTAP; ditado estruturado em SOAP; comandos de voz; atestado.
- **Assinatura ICP-Brasil** (`modules/signatures`): certificado A1 do profissional (PKCS#12) conferido
  (CPF do campo 2.16.76.1.3.1 igual ao da conta, validade, uso de chave, cadeia até as raízes da ICP-Brasil
  embarcadas) e guardado cifrado com a `DATA_KEY`; a senha é pedida a cada assinatura. O documento (registro
  do prontuário, receita, atestado) vira PDF (pdf-lib) e recebe uma assinatura PAdES (CMS/CAdES-BES com
  signing-certificate-v2, SHA-256/RSA) montada em ASN.1 puro; o PDF vai para o R2 e fica em `signed_documents`
  (hash SHA-256). O validador lê qualquer PDF: resumo, assinatura, certificado declarado, cadeia e se a
  assinatura cobre o arquivo todo; não consulta LCR/OCSP (revogação fica para o validador do ITI).
- **Farmácia** (`modules/pharmacy`): NF-e com De-Para e bloco `<rastro>` obrigatório, transferências com
  dupla conferência, unitarização com Datamatrix GS1, dispensação FEFO e controlados da Portaria 344,
  administração beira-leito com os 5 certos (baixa definitiva do estoque no ato), logística reversa.
- **Leitos/NIR** (`modules/beds`): censo em tempo real, internação com isolamento compatível,
  transferência e alta com sumário enviado à RNDS.

## Integrações

| Integração | Onde | Como |
|---|---|---|
| RNDS (HL7 FHIR R4) | `packages/fhir`, `modules/integrations/rnds.service.ts` | Outbox transacional; o job monta o Bundle (RAC, imunização, dispensação, sumário de alta), valida e envia com mTLS (certificado e-CNPJ do estabelecimento), backoff exponencial e descarte de erros permanentes. Token em `GET /api/token`, cabeçalhos `X-Authorization-Server` (token) e `Authorization` (CNS do solicitante), endereços oficiais por ambiente e UF (`rndsEndpoints`); teste de conexão e situação em Administração > Integrações (`docs/RNDS.md`) |
| CADSUS | `packages/fhir/src/cadsus.ts` | Consulta `Patient` na RNDS por CPF/CNS |
| WhatsApp Business (Cloud API) | `packages/messaging`, `modules/integrations/messaging.service.ts` | Confirmação 48h antes com botões; lembretes de adesão; janela de silêncio 22h–06h (adiado para 06h01); webhook com HMAC |
| SEFAZ (NF-e) | `modules/pharmacy` | Consulta de notas destinadas (mock REST em desenvolvimento) e upload de XML como contingência |
| e-SUS APS (LEDI 8.7.0, Thrift) | `packages/esus`, `modules/esus` | Esquema gerado dos `.thrift` oficiais, TBinaryProtocol próprio (sem dependência em produção), montagem das fichas a partir dos registros, validação prévia com as regras do dicionário, lotes com `.esus` em zip e envio pela API do PEC (`docs/ESUS.md`) |
| Indicadores da APS (componente de qualidade) | `packages/shared/src/aps-indicadores.ts`, `modules/indicators` | Fichas dos 15 indicadores, pesos, faixas e valores em código compartilhado; apuração mensal por equipe a partir de registros assinados, classificação de risco, exames, vacinas, produção e condições; lista nominal auditada; projeção do repasse (`docs/INDICADORES-APS.md`) |
| Programas da APS e estratificações | `packages/shared/src/aps-programas.ts`, `modules/programs` | Programas com ações programáticas, calendário vacinal e agenda de puericultura, intervalos do pré-natal, vigências do Bolsa Família, previsão de alta de TB/hanseníase; instrumentos (risco gestacional, pé diabético, M-CHAT-R) com pontuação em código compartilhado; listas auditadas ligadas à busca ativa (`docs/PROGRAMAS-APS.md`) |
| Vacinas | `packages/shared/src/vacinas.ts`, `modules/vaccines` | Calendário Nacional por grupo e estratégia com aprazamento em código compartilhado; sala de vacina com baixa do lote (estoque da farmácia), RIA para a RNDS com os códigos do e-SUS, certificado em PDF (assinável pelo módulo de assinaturas), faltosos e agenda (`docs/VACINAS.md`) |
| App do ACS | `packages/shared/src/acs.ts`, `modules/acs`, `apps/web/src/lib/acs-store.ts` | Papel ACS; território por equipe/microárea; operações de campo (pessoa, domicílio, visita) com `clientId` e sincronização idempotente (`field_sync_ops`, `home_visits`); fila e cache no IndexedDB, service worker das telas, mapa Leaflet; produtividade; ficha de visita domiciliar no e-SUS; visitas nos indicadores e programas (`docs/ACS.md`) |
| Regulação ambulatorial | `packages/shared/src/regulacao.ts`, `modules/regulation` | Protocolos de encaminhamento por especialidade e procedimentos regulados em código compartilhado; solicitação a partir do atendimento com verificação do protocolo, prioridade e prazo-meta; fila única ordenada; decisão do regulador com histórico, anexos, tempo real e devolutiva ao cidadão por WhatsApp; prestadores com contrato e tetos, PPI/cotas consumidas na autorização; agendamento regulado na agenda do executante (reaproveita `modules/scheduling`, com confirmação e remarcação pelo WhatsApp) e tempos médios (`docs/REGULACAO.md`) |
| TFD e transporte sanitário | `packages/shared/src/tfd.ts`, `modules/tfd`, `modules/transport` | Processo de TFD com laudo, protocolo, transições com eventos e auditoria, ajuda de custo calculada em código compartilhado, PDFs (`signatures/pdf`), devolutiva WhatsApp (`integrations/messaging`); frota, motoristas, rotas, viagens e passageiros com regras de lotação, acessibilidade e CNH, roteiro do dia e indicadores; a reserva do TFD reaproveita `TransportService.adicionarPassageiro` (`docs/TFD-TRANSPORTE.md`) |
| Central de leitos e AIH | `packages/shared/src/leitos.ts`, `modules/bed-regulation` | Solicitação de vaga com NEWS2 e prioridade sugerida em código compartilhado; fila, análise, segunda avaliação, autorização com reserva de leito (`BedsService.reservar`/`liberarReserva`), transferência e internação pelo fluxo do censo (`BedsService.admit` com `bedRequestId`); mapa da rede a partir do censo de cada unidade; eventos em tempo real por unidade e por tenant; AIH com faixas numéricas, dígito verificador e número gravado na internação para o espelho do faturamento; PDFs via `signatures/pdf` (`docs/REGULACAO-LEITOS.md`) |
| Regulação na RNDS | `packages/shared/src/rnds-regulacao.ts`, `packages/fhir/src/builders/regulation.ts`, `modules/integrations/rnds-regulacao.ts`, `modules/regulation/regulation-rnds.service.ts` | Mapeamento das situações para o MIRA e invariantes em código compartilhado; construtor do RIRA (Composition RA + Appointment + ServiceRequest + Condition) no pacote FHIR, conferido com o guia oficial; outbox `RNDS_REGULACAO` gravado nas transições da regulação ambulatorial, da central de leitos e da internação pelo censo; documento montado no envio pelo `RndsService`, com `relatesTo replaces` do anterior; conferência (painel, documentos, prévia validada, reenvio, carga inicial) na aba Envio à RNDS (`docs/RNDS.md` §6) |
| App do cidadão | `packages/shared/src/cidadao.ts`, `modules/citizen`, `apps/web/src/app/cidadao`, `apps/web/src/components/citizen` | Token com estágio `citizen` (sub = paciente) emitido após código de uso único (hash em `citizen_access_codes`; WhatsApp 10 min ou recepção 24 h); guard global só libera rotas `@CitizenRoute()` para esse token e nega os demais; leitura dos mesmos registros da rede (agenda, exames, vacinas, farmácia, regulação, TFD, fila) com nomes e máscaras pensados para o cidadão; confirmação e cancelamento reaproveitam o `SchedulingService` (vaga volta à lista de espera); telas fora do grupo `(app)` com armazenamento e cliente HTTP próprios (`docs/CIDADAO.md`) |
| Assistente do WhatsApp | `packages/ai-engine/src/assistant.ts`, `modules/assistant`, `apps/web/src/app/(app)/assistente` | Webhook do WhatsApp entrega textos e botões `ASSIST:*` ao `AssistantService`; identificação pelo telefone só com WhatsApp autorizado; leitura por regras (menu e palavras-chave) sempre, modelo com saída estruturada (zod) quando a IA está ativa; sinais de alerta por regra prevalecem (emergência); dados e transações vêm do `CitizenService` e do `SchedulingService` (mesmas regras de cota, confirmação e cancelamento); conversas e mensagens em tabelas próprias; passagem para atendente com aviso em tempo real e resposta humana pelo mesmo número (`docs/ASSISTENTE-WHATSAPP.md`) |
| Ouvidoria, satisfação e Meu SUS Digital | `packages/shared/src/ouvidoria.ts`, `modules/ombudsman`, `modules/integrations/meu-sus-digital.ts` | Manifestação com protocolo e prazo legal (30 dias, prorrogação única) em código compartilhado; tramitação com eventos e auditoria; identidade oculta nas anônimas; canais app, WhatsApp (assistente) e balcão; aviso ao cidadão por modelo de WhatsApp; pesquisa de satisfação criada no encerramento do atendimento e respondida por botão do WhatsApp (assistente) ou pelo app; resumo do Meu SUS Digital calculado do outbox da RNDS por pessoa (`docs/OUVIDORIA.md`) |
| Vigilância: notificação compulsória | `packages/shared/src/vigilancia`, `scripts/vigilancia`, `modules/vigilancia` | Catálogo da LNNC gerado do compilado oficial (extrator de tabela HTML + curadoria) e gravado por instituição com versões nacional, estadual e municipal e retrato na data; de-para CID-10/CIAP-2 por prefixo mais longo; semana epidemiológica e prazos (24 h, 7 dias, repasse 24 h) em código compartilhado; gatilho depois do commit em `ClinicalService.signNote`/`close` e `BedsService.admit`, protegido (falha auditada) e recuperado pela tarefa `vigilancia` a cada 5 minutos, que também escala ao plantão por modelo de WhatsApp sem dado pessoal e marca prazo vencido; idempotência por índice único parcial (atendimento, agravo); ficha FIN do Sinan Net v5 como retrato JSON; sigilo por agravo com auditoria de leitura; plantão nas configurações do tenant (banco mestre) (`docs/VIGILANCIA.md`) |
| Vigilância: saída para os sistemas oficiais e REL | `packages/shared/src/vigilancia/{sistemas,srag,exames}.ts`, `modules/vigilancia/{saida,catalogo}.service.ts`, `packages/fhir/src/builders/rel.ts` | Rotas agravo → sistema em tabela com vigência (semeada das notas técnicas, nova vigência fecha a anterior); fila de digitação como estado da notificação (`entry_status`), número oficial com índice único parcial por sistema (exceto Sinan Net, conferido na aplicação pela chave número + data + município + agravo, sob advisory lock); espelho, PDF e CSV gerados de uma única lista de linhas na ordem da FIN v5; encerramento validado em código compartilhado com a numeração do sistema de destino; resultado de exame qualitativo dispara a notificação depois do commit e o REL pelo outbox `RNDS_REL` (Bundle document REL 3.2.1 validado antes do envio); comunicação policial com PDF sem cabeçalho do paciente salvo modelo que o peça (`docs/VIGILANCIA.md`) |
| Território georreferenciado | `packages/shared/src/territorio/{geo,regras}.ts`, `modules/territorio`, `modules/vigilancia/mapa.service.ts`, `components/territorio` | Geometria em TypeScript (ponto no polígono com buracos, distância à borda em metros pela latitude local, área, sobreposição) porque o PostGIS exige superusuário no PlanetScale; contorno GeoJSON normalizado em `jsonb` com caixa envolvente e centro indexados para a busca por caixa; vínculo imóvel → quarteirão com tolerância de 15 m e índice em grade no lote; leitura de shapefile com `shapefile` + `fflate` e reprojeção com `proj4` (SIRGAS 2000 graus e UTM; SAD69 recusado); prévia guardada no armazenamento e aplicada com estado (`PREVIA` → `APLICANDO` → `APLICADA`); geocodificação só local pelo CNEFE com precisão ordenada que nunca piora; configuração (numeração, raio) nas configurações do tenant; mapa de casos com escopo e sigilo da notificação e auditoria (`docs/TERRITORIO.md`) |
| Endemias: ACE em campo e bloqueio | `packages/shared/src/endemias.ts`, `modules/endemias`, `lib/ace-store.ts`, `components/endemias`, `app/(app)/campo-ace` | A notificação avisa um ouvinte depois do commit (`NotificacaoService.aoMudarNotificacao`, sem dependência circular; as mudanças que não mexem na ordem não avisam) e o `BloqueioService` compara o retrato do caso e só então decide sob trava consultiva (`pg_try_advisory_xact_lock` com poucas tentativas curtas fora da transação; ocupada, desiste e a varredura liga depois), relendo a notificação dentro da trava: o caso entra numa ordem ativa (até 2× o raio e 7 dias, sem cadeia) ou abre outra, e ordens que passam a agrupar são unidas inteiras (`mergedIntoId`). O recálculo trava a linha da ordem (`FOR UPDATE`) e só muda a situação entre aguardando e aberta. O território expõe um registro de ouvintes de posição (`TerritorioService.aoMudarPosicaoImovel`/`imoveisPosicionados`), chamado ao posicionar, geocodificar, religar a malha e no GPS das visitas do ACS e do ACE, que reavalia os casos na hora; varredura a cada 5 min (job `endemias`) recupera falhas. O evento `endemias:ordem` vai só para a sala das endemias no WebSocket. O app do ACE tem banco próprio no IndexedDB (`omnisaude-campo-ace`: fila presa ao usuário e à lotação, pacote, histórico, tubitos), em que ler e regravar a fila, o histórico e o pacote é sempre uma transação só (`BancoLocal.atualizarVarios`); cada registro da fila tem a versão (sobe a cada correção) e a versão enviada sem resposta (`semResposta`, posta antes do POST), para que a DUPLICADA de outra versão seja tomada como da que o servidor gravou; a sincronização valida cada operação sozinha (`campo.schema.ts`), grava a entidade, o `field_sync_ops` e a baixa do larvicida numa transação (saldos travados na ordem dos lotes, `client_id` único e índice parcial único no movimento de estoque, então o reenvio simultâneo volta como DUPLICADA), repete no servidor as falhas passageiras (`erros-banco.ts`) e devolve TENTAR_DE_NOVO se continuarem; a baixa sem saldo não aborta a transação (`tryDebit`) e fica pendente. Produção e pendências são somadas no banco. A visita vira a ficha de visita do e-SUS (tipo 8) por agente, CBO e dia, e `esus_record_items` registra em que ficha foi cada registro para nenhum sair em dois lotes (`docs/ENDEMIAS.md`, `docs/ESUS.md`) |
| Vigilância: consolidação e detecção de surto | `packages/shared/src/vigilancia/{agravos-sinan,diagrama,contingencia,surto,negativa,api-*}.ts`, `modules/vigilancia/{importacao,conciliacao,consolidado,diagrama,populacao,contingencia,surto,negativa}.*`, `modules/vigilancia/importacao/`, `components/consolidacao` | Migração 0031 (SQL à mão) com 17 tabelas. Importação: `official_imports` (o envio: situação PROCESSANDO, PREVIA, APLICADA, DESCARTADA, FALHOU ou SUBSTITUIDA, com CHECKs de coerência; arquivos detectados, com o CNES do arquivo do e-SUS de um estabelecimento só (o mesmo critério da cobertura dos ausentes, arquivo por arquivo), contagens, prévia e payload normalizado em linhas com gzip, gravado em fatias, que some ao aplicar, descartar ou expirar; etapa e sinal de vida do trabalho em segundo plano, erro e resultado da aplicação, com a cobertura dos ausentes que ela usou (`apply_result.cobertura`, uma entrada por arquivo, que a substituição do mesmo arquivo consulta para saber se outra aplicação confirma um ausente; a API não a mostra); índice único parcial no SHA-256 e no período declarado, só na APLICADA: o mesmo arquivo aplicado de novo com outro período substitui a aplicação anterior, que vira SUBSTITUIDA, com `superseded_by` apontando a nova), `official_records` (registro oficial único por sistema, tipo e chave natural; mescla campo a campo guiada por `data._fontes`; ausente marcado com `absent_since` e a importação que o marcou (`absent_import_id`, com índice parcial; a CHECK `official_records_ausencia` exige os dois juntos), em vez de apagar; uma notificação casa com um registro só, por índice único parcial; índices na última importação, em sistema + tipo + data e no número sem zeros, com a mesma expressão da conciliação) e `official_record_rejections` ("não é o mesmo caso"). Diagrama: `population_estimates` (ano, nível, território, fonte e versão; chave única com COALESCE no território), `diagram_settings` (receita por agravo como dado) e `control_channels` (canal congelado com versão; um ativo por agravo, território e ano). Contingência: `contingency_plans` (definição em jsonb; um vigente por escopo; versão única no escopo; a mesma trava consultiva do escopo na criação, na edição e na vigência; CHECK de vigência), `contingency_activations` (um aberto por plano e território; CHECK de vigência), `contingency_inputs` e `contingency_action_items`. Surto: `outbreaks` (numeração AAAA/NNNN com trava do ano), `outbreak_cases`, `outbreak_events` e `outbreak_dismissals`. Negativa: `notifying_units` (um período aberto por unidade; semeado na migração; `next_removed_at` marca o último período quando a desativação apagou o planejado), `notifying_unit_responsibles` e `negative_reports` (um ATESTADA por unidade e semana; o prazo usado no atesto em `deadline_at`, obrigatório). Regras puras em código compartilhado (funções do Excel em precisão total, avaliação do plano, aglomerados, grade); leitura em fluxo (zip pelo diretório central, com teto de 1.000 entradas conferido antes de montar a lista e tamanho real e CRC conferidos; uma parte por tipo de arquivo em cada registro; CSV e DBF em pedaços, com o código de página do DBF pelo byte 29; registros normalizados num arquivo temporário; tetos de 150 MB descompactados e 400 mil registros por envio); detecção do tipo pelo conteúdo; uma prévia ou aplicação por vez no processo, em segundo plano depois de 20 s (202 e acompanhamento sem a prévia nominal, sinal de vida a cada 15 s com `FOR NO KEY UPDATE SKIP LOCKED`, que não espera a trava das chaves estrangeiras dos registros gravados, trabalho interrompido reconhecido pelo sinal parado); antes de ler o corpo cru (abaixo), 409 IMPORTACAO_OCUPADA quando o tenant tem outra importação viva e IMPORTACAO_SERVIDOR_OCUPADO quando a vez do processo está com a importação de outro tenant (conferida de novo depois do corpo), o tenant já tem um arquivo na memória ou o processo já tem 2 (as cargas do processo, abaixo); gravação por SQL com parâmetro JSON (inserção e UPDATE em lote por `jsonb_to_recordset`), porque o runtime do Prisma 7 guarda os argumentos das últimas 100 chamadas; conciliação, listas e resumo em SQL paginado; base consolidada agregada no banco (GROUP BY) com a cobertura por SE e os quarteirões localizados em lote (`LocalizadorService.quarteiroesDosPontos`: duas consultas e ponto no polígono em memória, com os mesmos 200 candidatos, na mesma ordem, e o mesmo resultado da consulta de um ponto, `docs/TERRITORIO.md`); aplicação numa transação com as travas consultivas da importação e da conciliação, nessa ordem (a cadeia completa está abaixo); a confirmação da notificação e a tarefa `vigilancia` reconciliam os atestos e expiram as prévias, e a tarefa roda a conciliação automática (trava tentada, sem espera) (`ModuleRef`, sem dependência circular) (`docs/VIGILANCIA.md`) |
| DATASUS SIGTAP / BPA | `modules/billing` | Leitura do pacote oficial (zip + layouts), sincronização no primeiro dia útil, crítica pré-glosa, BPA-I/BPA-C no layout oficial de exportação (`bpa-layout.ts`, com CPF do indivíduo e situação de rua) e conferência de arquivos BPA (`validateBpaFile`) |
| Claude (Anthropic) | `packages/ai-engine/src/llm` | Saídas estruturadas (zod), fallback em recusas, modelo configurável |
| Cloudflare R2 | `apps/api/src/core/storage.service.ts` | API S3; SHA-256 conferido na leitura |
| VLibras / WebRTC | `packages/accessibility`, `modules/accessibility` | Widget oficial; central de intérpretes e sinalização WebRTC por Socket.IO |

- **Corpo cru dos envios** (`apps/api/src/core/raw-body.ts`): o zip da SIGTAP enviado cru (até 60 MB) e as
  exportações oficiais da vigilância (até 95 MB) são lidos fora dos parsers JSON e texto do `main.ts`. Com
  Content-Length, o tamanho acima do limite dá 413 antes de ler qualquer byte, e o Buffer é alocado uma vez, no
  tamanho declarado; mais bytes que o declarado dão 400 ENVIO_INVALIDO, e o fim antes do declarado (ou o cliente que
  cai) dá 400 ENVIO_INCOMPLETO ("O envio chegou incompleto. Envie o arquivo de novo."). Sem Content-Length (envio em
  pedaços), os pedaços são juntados até o limite (acima dele, 413). Sem pedaço novo por 30 s, 408 ENVIO_PARADO ("O
  envio parou de chegar. Envie o arquivo de novo."). Nos erros com o corpo pela metade, a resposta sai com
  `Connection: close`, o resto do corpo não é lido e a conexão é derrubada em até 5 s. O webhook do WhatsApp continua
  com o `rawBody` do Nest, para conferir a assinatura (HMAC). O ingress do k8s aceita corpos de até 100 MB.
- **Cargas do processo** (`CargasDoProcesso`, no mesmo arquivo): um contador só, dividido entre a importação da
  vigilância e o upload da SIGTAP, com no máximo 2 arquivos na memória do processo, de qualquer tenant, e 1 por tenant,
  contando os dois envios. Quem lê reserva a carga antes de ler o corpo; no teto, 409 IMPORTACAO_SERVIDOR_OCUPADO sem
  ler o corpo (o Node descarta o resto), com "O servidor está recebendo ou processando outros envios agora. Tente de
  novo em instantes." (processo) ou "Outro envio da sua instituição está sendo recebido agora. Tente de novo quando ele
  terminar." (tenant). No `POST /api/billing/sigtap/import`, a ordem é o 413 pelo Content-Length acima de 60 MB e
  depois a reserva (também no envio em JSON, `{ fileBase64 }`), que fica presa até a carga das tabelas acabar e sai em
  qualquer resposta; a tela do faturamento mostra a mensagem da API. Na importação, a carga fica presa enquanto o
  arquivo está na memória (o corpo e a leitura em segundo plano). Assim, o upload da SIGTAP e a importação da
  vigilância do mesmo tenant não correm ao mesmo tempo.
- **Filtro global de erros** (`apps/api/src/core/errors.ts`): o `DomainError` responde com o status, o código e a
  mensagem dele, e a `HttpException` com o status e a mensagem; o P2002 do Prisma, 409 DUPLICADO "Registro duplicado";
  o P2025, 404 NAO_ENCONTRADO. O impasse (40P01) e a falha de serialização (40001) do Postgres respondem 409
  OPERACAO_SIMULTANEA "Outra operação alterou os mesmos dados ao mesmo tempo. Tente de novo em instantes.", sem
  `details`: o banco desfez a transação, e repetir resolve. O código é lido em cada forma em que o erro chega: o
  Prisma 7 com o adaptador do pg (P2010 na consulta crua, P2034 na do modelo, com o código em
  `meta.driverAdapterError.cause.originalCode` e o tipo `TransactionWriteConflict`), o P2010 do motor antigo
  (`meta.code`), o erro do adaptador solto e o do pg puro (`code`). O impasse não sai como erro no log, e sim como
  aviso ("Operação desfeita pelo banco (40P01): <pilha>"). O texto com o caractere nulo que o Postgres recusa (22021
  num `text`, 22P05 num `jsonb`; P2010 na consulta crua, P2039 na do modelo) responde 400 VALIDACAO "O pedido tem
  texto com caractere inválido (como o caractere nulo, U+0000). Corrija e envie de novo.". O resto responde 500 "Erro
  interno", com a pilha no log. Os campos de busca e de nome curto validados com `textoSemControle`
  (`apps/api/src/core/zod.ts`: sem os espaços das pontas, até o tamanho máximo e sem caractere de controle, U+0000 a
  U+001F e U+007F a U+009F) recusam antes, com o 400 VALIDACAO do zod e o campo em `details`; o filtro cobre o
  caractere nulo que chega ao banco por outro caminho.
- **Travas consultivas da vigilância** (`pg_advisory_xact_lock` e `pg_try_advisory_xact_lock` sobre o `hashtext` da
  chave), numa ordem só: `vigilancia:importacao`, depois `vigilancia:conciliacao`, depois `surto-caso:<id>` em ordem
  crescente de uuid. A aplicação da importação pega as duas primeiras, esperando, no início da transação; a
  conciliação automática, dentro dela, pega a da conciliação de novo (é reentrante). A tarefa `vigilancia` tenta as
  duas sem esperar e pula a rodada se alguma estiver ocupada. Vincular, desvincular, rejeitar e a conferência de antes
  de preencher o número oficial tentam a da conciliação em transações curtas; sem ela, esperam 100 ms fora da
  transação (a conexão volta ao pool) e tentam de novo por até 3 s, e então respondem 409 CONCILIACAO_OCUPADA. O
  vincular, já com a da conciliação, pega as `surto-caso` dos surtos que têm a notificação ou o registro. A inclusão
  de caso no surto segura só a `surto-caso` do surto e nunca pede as outras duas; o vínculo automático não pega
  `surto-caso` e confere o par na própria gravação. Fora dessa cadeia, cada trava é pedida sozinha:
  `contingencia-plano:<escopo>` (criar, editar e pôr em vigor o plano), `surto-numero:<tenant>:<ano>` (número do
  surto) e a da negativa, que segue a sua ordem: `negativa-responsavel:<unidade>`, a linha da unidade (só na
  desativação no cadastro), as linhas de `notifying_units` com `FOR UPDATE` ou as das designações, as linhas da
  unidade e do usuário que a gravação pede pelas chaves estrangeiras e, por último, a trilha de auditoria. A designação
  de responsável grava a auditoria no fim, depois da designação nova (como o encerramento da unidade notificante):
  assim, o cadastro que troca o CNES da unidade, ou o CPF ou o CNS do usuário, e só depois audita, espera a designação
  na linha, sem fechar ciclo com a trava da trilha. O impasse que sobrar em outro caminho responde 409
  OPERACAO_SIMULTANEA.

O servidor `infra/mocks` simula RNDS/CADSUS, SEFAZ e WhatsApp para desenvolvimento e testes. Os testes da API rodam
contra PostgreSQL real (`apps/api/test/harness.ts`). O `fileParallelism: false` do projeto api em `vitest.config.ts`
é ignorado pelo Vitest 3.2.7, porque o pool de forks lê a opção da raiz da configuração. Por isso a suíte da API roda
3 arquivos ao mesmo tempo (o padrão do Vitest, CPUs − 1, numa máquina de 4 CPUs), cada um com os seus bancos
(`omni_test_master_<arquivo>` e `tenant_db_t_<arquivo>`).

## Text-to-SQL blindado

1. O modelo recebe só o catálogo das views `bi.*` e a pergunta (nenhum dado de paciente).
2. A SQL gerada passa pelo validador de AST (`packages/ai-engine/src/sql-guard.ts`, parser real do
   PostgreSQL via WASM): uma única instrução `SELECT`, sem `INTO`, sem `FOR UPDATE`, sem CTE de escrita,
   relações só da allowlist de views, funções só da allowlist (nada de `pg_sleep`, `dblink`,
   `pg_read_file`, `set_config`...), catálogos do sistema bloqueados.
3. Executa na réplica, em transação somente leitura, com `statement_timeout` e paginação.
4. Mesmo que algo escape do validador, o papel `omni_bi` não lê tabelas nem escreve.

## Tempo real e jobs

- Socket.IO `/rt`: sala por unidade (`senha.chamada`, `fila.atualizada`, `censo`, `alerta.emergencia`).
  O painel de TV usa um token próprio, somente leitura, válido por 30 dias.
- Socket.IO `/libras`: sinalização WebRTC do teleatendimento em Libras.
- Jobs (BullMQ): disparo de WhatsApp (30 s), outbox RNDS (60 s), SIGTAP (diário nos primeiros dias do mês;
  só sincroniza no primeiro dia útil). O banco é a fonte da verdade, então repetir um job não duplica envio.
  Sem Redis, um temporizador local faz o mesmo (desenvolvimento). Na Cloudflare, os Cron Triggers do Worker
  chamam `POST /api/jobs/tick` (protegido por `JOBS_SECRET` e fechado ao público pelo Worker).

## Front-end e app Android

- Next.js 16 (App Router) + Tailwind 4 + componentes próprios sobre Radix. Telas são componentes de cliente
  e rotas usam `?id=`, para que o mesmo código seja exportado como site estático (`OMNI_STATIC_EXPORT=1`) e
  empacotado pelo Capacitor no Android.
- `src/lib/native.ts` escolhe entre plugin nativo (ML Kit para Datamatrix/QR, câmera, reconhecimento de fala
  do Android, TTS) e a API do navegador (BarcodeDetector, `getUserMedia`, Web Speech, `speechSynthesis`).

## Publicação

- **Cloudflare** (`apps/cloudflare`, guia em `docs/PUBLICACAO.md`): um Worker atende `mm.api.br/omnisaude*`.
  As telas são a exportação estática do Next.js servida pelo Workers Static Assets; `/omnisaude/api` e
  `/omnisaude/socket.io` vão para a API no Cloudflare Containers (classe `OmniApi`, instância única), com o
  prefixo retirado e o IP real do cliente em `X-Forwarded-For`. Na partida o container roda
  `cli.js boot`: cria papéis e o `master_auth_db` no PostgreSQL do PlanetScale com o papel administrador do
  provedor, aplica migrações e, na demonstração, cria o tenant `demo`. O usuário de conexão do PlanetScale
  (`papel.branch`, com `|replica` para o BI) é traduzido para o nome do papel nos comandos SQL
  (`roleName`). Quando variáveis ou segredos do Worker mudam, o Worker reinicia a API com os valores novos.
- **Servidor próprio** (`deploy/producao`, guia em `docs/PUBLICACAO-SERVIDOR.md`): Docker Compose com Caddy
  (HTTPS automático), PostgreSQL com réplica por streaming, Redis e worker separado.

## Escalabilidade e limites conhecidos

- Várias réplicas da API exigem afinidade de sessão para o Socket.IO (ou o adaptador Redis do Socket.IO) e
  uma central de intérpretes compartilhada (hoje em memória, por instância).
- O cache do catálogo de roteamento tem 60 s: uma suspensão ou uma configuração salva leva até isso para valer em
  outras instâncias (por exemplo, nas telas da grade e do responsável da notificação negativa). O atesto da negativa
  e a tela de parâmetros da vigilância leem o banco mestre na hora.
- Veja `docs/STATUS.md` para o que está completo, parcial ou pendente em relação à especificação.
