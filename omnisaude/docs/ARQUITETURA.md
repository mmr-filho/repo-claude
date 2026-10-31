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
- **`tenant_db_<slug>`** (`prisma/tenant/schema.prisma`, 54 tabelas): todos os dados assistenciais,
  operacionais e de faturamento do contratante. Cada banco tem backup, restauração e expurgo próprios.
- **Réplica de leitura** (`tenant_db_<slug>_readonly` no catálogo): a mesma base replicada por streaming.
  O BI e o Text-to-SQL só usam a réplica, com o papel `omni_bi_reader` (grupo `omni_bi`), que enxerga
  apenas as views do schema `bi`. O pool define `search_path=bi`, `default_transaction_read_only=on` e
  `statement_timeout`.
- **Roteamento dinâmico** (`packages/database/src/tenancy.ts`): `TenantConnectionManager` resolve o tenant
  no catálogo (cache de 60 s), abre um `PrismaClient` com o adaptador `pg` por banco (LRU com limite de
  tenants abertos) e confere o status a cada uso: um tenant suspenso perde o acesso mesmo com conexões
  abertas.
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
- **RBAC híbrido** (`packages/shared/src/roles.ts`): 9 papéis × 40 permissões. A guarda global nega por
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
| DATASUS SIGTAP / BPA | `modules/billing` | Leitura do pacote oficial (zip + layouts), sincronização no primeiro dia útil, crítica pré-glosa, BPA-I/BPA-C no layout oficial de exportação (`bpa-layout.ts`, com CPF do indivíduo e situação de rua) e conferência de arquivos BPA (`validateBpaFile`) |
| Claude (Anthropic) | `packages/ai-engine/src/llm` | Saídas estruturadas (zod), fallback em recusas, modelo configurável |
| Cloudflare R2 | `apps/api/src/core/storage.service.ts` | API S3; SHA-256 conferido na leitura |
| VLibras / WebRTC | `packages/accessibility`, `modules/accessibility` | Widget oficial; central de intérpretes e sinalização WebRTC por Socket.IO |

O servidor `infra/mocks` simula RNDS/CADSUS, SEFAZ e WhatsApp para desenvolvimento e testes.

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
- O cache do catálogo de roteamento tem 60 s: uma suspensão leva até isso para valer em outras instâncias.
- Veja `docs/STATUS.md` para o que está completo, parcial ou pendente em relação à especificação.
