# OmniSaúde

Sistema integrado de gestão para redes públicas de saúde municipais e consórcios intermunicipais: da
Atenção Primária (UBS) à urgência (UPA) e ao hospital, com farmácia rastreável do fornecedor ao leito,
faturamento SUS, interoperabilidade com a RNDS, WhatsApp e uma camada de IA (visão, voz, copiloto clínico
e BI conversacional).

> Nome inicial do projeto. A especificação de origem é o documento "SIGS-SUS + AI".

## O que já funciona

- **Multitenancy de verdade**: um banco PostgreSQL por contratante, catálogo de roteamento no
  `master_auth_db`, réplica de leitura para BI e provisionamento de novos tenants por linha de comando ou API.
- **Acesso por contexto**: login por CPF, 2FA (TOTP), escolha de unidade + papel, 9 papéis e 40 permissões,
  negação por padrão em toda rota.
- **Trilha de auditoria imutável** com hash SHA-256 encadeado (conteúdo + instante UTC + IP + 2FA).
- **Recepção**: OCR de documentos (via Claude), CADSUS pela RNDS, duplicidade, senhas e painel de chamada
  com voz, pulseira com QR.
- **Classificação de risco (ACCR)** com mapa de dor e fila por gravidade.
- **Prontuário SOAP** com ditado, assinatura e prescrição com **copiloto clínico** (interações, alergias,
  função renal, gestação...), linhas de cuidado com exames SIGTAP e atestado.
- **Agenda** com cotas, bloqueios, lista de espera e **confirmação por WhatsApp** 48h antes, respeitando a
  janela de silêncio (22h–06h).
- **Farmácia**: NF-e com `<rastro>`, De-Para, transferências com dupla conferência, unitarização com
  Datamatrix GS1, dispensação (Portaria 344) e **administração beira-leito com os 5 certos**.
- **Leitos/NIR**, **POPs** (hard e soft gates), **faturamento** (SIGTAP, crítica pré-glosa, BPA-I/BPA-C),
  **BI conversacional** com Text-to-SQL blindado, **gestão** (produtividade, SLAs, pautas) e **busca ativa**.
- **Acessibilidade**: VLibras e chamada de intérprete de Libras por vídeo (WebRTC).

O que está parcial ou pendente está listado em [`docs/STATUS.md`](docs/STATUS.md). A arquitetura está em
[`docs/ARQUITETURA.md`](docs/ARQUITETURA.md). A publicação em `https://mm.api.br/omnisaude`, 100% na Cloudflare
(Workers, Containers, PlanetScale e R2), está em [`docs/PUBLICACAO.md`](docs/PUBLICACAO.md); num servidor
próprio com Docker Compose, em [`docs/PUBLICACAO-SERVIDOR.md`](docs/PUBLICACAO-SERVIDOR.md).

## Estrutura

```
apps/api               NestJS: REST, WebSockets (Socket.IO), filas BullMQ e worker
apps/web               Next.js 16: desktop, tablet e mobile web (também exportado para o app)
apps/mobile            Capacitor 8: app Android (smartphones e tablets)
apps/cloudflare        publicação na Cloudflare: Worker (telas estáticas, rota da API, jobs) e container da API
packages/shared        papéis/permissões, CPF/CNS, ACCR, GS1, datas
packages/database      esquemas Prisma (master e tenant), migrações, roteamento, auditoria, carga demo
packages/ai-engine     OCR, Speech-to-SOAP, copiloto clínico, protocolos, Text-to-SQL com validação AST
packages/messaging     WhatsApp Business (Cloud API) com regras de horário
packages/fhir          FHIR R4 para a RNDS, cliente mTLS e CADSUS
packages/accessibility VLibras e WebRTC para intérpretes de Libras
infra/mocks            RNDS/CADSUS, SEFAZ e WhatsApp simulados
docker/, deploy/       Postgres com réplica, Docker Compose (desenvolvimento e produção) e manifestos Kubernetes
```

## Como rodar

### Com Docker (tudo de uma vez)

```bash
cd omnisaude
docker compose up --build
```

Sobe Postgres master, Postgres dos tenants com réplica por streaming, Redis, mocks, a migração com o tenant
de demonstração, a API (`:3001`), o worker e a web (`:3000`). Abra http://localhost:3000.

### Sem Docker (desenvolvimento)

Requisitos: Node 22.12+, PostgreSQL 15+ e (opcional) Redis.

```bash
cd omnisaude
npm install
psql -U postgres -f docker/postgres/01-roles.sql
psql -U postgres -c "CREATE DATABASE master_auth_db OWNER omni_app"
cp apps/api/.env.example apps/api/.env   # ajuste host/porta do Postgres
npm run build:libs
npx tsc -b apps/api infra/mocks
set -a && . apps/api/.env && set +a
node packages/database/dist/cli.js seed  # migrações + tenant "demo"
node infra/mocks/dist/index.js &         # RNDS/CADSUS, SEFAZ, WhatsApp simulados (:4010)
node apps/api/dist/main.js &             # API (:3001)
npm run dev -w @omnisaude/web            # web (:3000)
```

### Acesso de demonstração

Instituição **`demo`**, senha **`OmniSaude2026`** para todos:

| Papel | CPF | Lotação |
|---|---|---|
| Recepção | 100.000.001-08 | UBS Centro, UPA 24h Norte |
| Enfermagem | 100.000.002-80 | UPA, Hospital, UBS |
| Técnica de enfermagem (dupla checagem) | 100.000.010-90 | Hospital |
| Médica | 100.000.003-61 | UBS, UPA, Hospital |
| Cirurgião-dentista | 100.000.004-42 | CEO |
| Serviço social | 100.000.005-23 | UBS, Hospital |
| NIR | 100.000.006-04 | Hospital |
| Farmácia | 100.000.007-95 | Farmácia Central, Hospital, Almoxarifado, UPA |
| Faturamento | 100.000.008-76 | UBS, UPA, Hospital |
| Gestão | 100.000.009-57 | UBS, UPA, Hospital, Farmácia Central |

Operação da plataforma: `plataforma@omnisaude.dev` (mesma senha), em `POST /api/platform/login`.

Todos os dados de demonstração são fictícios (CNES iniciados por 9, CPFs/CNS gerados com dígitos válidos).

## Testes

```bash
cd omnisaude
npx vitest run --project packages   # bibliotecas
npx vitest run --project api        # API contra Postgres real (OMNI_TEST_PG, padrão 127.0.0.1:54329)
```

Os testes da API criam bancos próprios por arquivo e exigem os papéis de `docker/postgres/01-roles.sql`.

## Configuração principal

| Variável | Uso |
|---|---|
| `MASTER_DATABASE_URL` | master_auth_db |
| `TENANT_DB_HOST/PORT`, `TENANT_REPLICA_HOST/PORT` | primário e réplica dos bancos de tenant |
| `TENANT_DB_*`, `TENANT_ADMIN_*`, `TENANT_BI_*` | credenciais da aplicação, do provisionamento e do BI |
| `DB_SSL`, `DB_POOL_SIZE` | TLS com o banco (bancos gerenciados) e conexões por banco de tenant |
| `PLATFORM_ADMIN_EMAIL/PASSWORD` | conta de operação da plataforma criada na partida (`cli.js boot`/`seed`) |
| `JWT_SECRET`, `DATA_KEY` | assinatura das sessões e chave AES-256 de segredos guardados |
| `REDIS_URL`, `RUN_JOBS` | filas BullMQ e jobs em segundo plano |
| `JOBS_SECRET` | disparo externo dos jobs (`POST /api/jobs/tick`), usado pelos Cron Triggers da Cloudflare |
| `ANTHROPIC_API_KEY`, `OMNI_AI_MODEL` | IA (OCR, ditado estruturado, BI); padrão `claude-opus-5-5` |
| `R2_*` | Cloudflare R2 (documentos); sem isso, pasta local |
| `RNDS_*` | URLs, certificado ICP-Brasil (PFX: caminho ou `r2:<chave>`) e CPF do solicitante |
| `WHATSAPP_*` | Cloud API (número, token, segredo do app, token de verificação) |
| `SIGTAP_ZIP_URL` | origem do pacote mensal da SIGTAP (`{competencia}` é substituído) |
| `MOCKS_URL` | aponta RNDS, SEFAZ e WhatsApp para os mocks em desenvolvimento |

Integrações também podem ser configuradas por tenant em `tenant_integrations` (master), com o segredo
referenciado pelo nome da variável de ambiente.

## Antes de usar em produção

- Validar com as fontes oficiais: perfis FHIR da RNDS, layout BPA do DATASUS, mapeamento de instrumentos da
  SIGTAP e a base de conhecimento do copiloto clínico (semente de desenvolvimento, sem revisão da comissão
  de farmácia e terapêutica).
- Aprovar na Meta os templates de WhatsApp e obter o credenciamento na RNDS com certificado ICP-Brasil.
- Revisar o tratamento de dados com o encarregado (LGPD), sobretudo o uso de IA externa em documentos e
  transcrições.
