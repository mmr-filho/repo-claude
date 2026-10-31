# Publicação 100% na Cloudflare: https://mm.api.br/omnisaude

Tudo roda na sua conta da Cloudflare, sem servidor, sem túnel e sem Docker no seu computador:

```
navegador ──HTTPS──► Cloudflare: Worker "repo-claude" (rota mm.api.br/omnisaude*)
                      ├─ /omnisaude/*                          → telas (arquivos estáticos do Next.js)
                      └─ /omnisaude/api, /omnisaude/socket.io  → API NestJS no Cloudflare Containers
                                                                   ├──TLS──► PostgreSQL (PlanetScale)
                                                                   └───────► R2 (documentos)
Cron Triggers do Worker (a cada 5 min e 1x por dia) → jobs de WhatsApp, RNDS e SIGTAP
```

A configuração está em `wrangler.jsonc` (na pasta `omnisaude`) e o código do Worker em `apps/cloudflare`. O restante de
`mm.api.br` não é afetado: o Worker só recebe o que começa com `/omnisaude`.

> **Atenção:** com `SEED_DEMO=true` (padrão) sobe a instituição de demonstração `demo`, com dados fictícios e
> a senha pública `OmniSaude2026` (que está no README). Qualquer pessoa com o endereço consegue entrar. Não
> cadastre pacientes reais nela. Para uso real ainda falta, entre outros pontos de `docs/STATUS.md`, a tela de
> cadastro de profissionais.

## O que é preciso

- Conta da Cloudflare com o plano **Workers Paid** (o Cloudflare Containers exige) e o domínio `mm.api.br`
  nela.
- Acesso ao repositório `mmr-filho/repo-claude` no GitHub (a Cloudflare constrói tudo a partir dele).
- Só o navegador e o PowerShell do Windows. Docker é opcional (veja "Alternativa: publicar do seu computador").

## Passo 1: banco PostgreSQL no PlanetScale (cobrado pela Cloudflare)

1. No painel da Cloudflare: **Storage & databases → Postgres & MySQL (Hyperdrive)** e escolha criar um banco
   do **PlanetScale**. Autorize a organização; você é levado ao PlanetScale.
2. No PlanetScale: nome `omnisaude`, motor **Postgres**, a região mais próxima dos usuários (São Paulo, se
   houver) e o tamanho do cluster. Clusters com réplica permitem que o BI leia da réplica; num cluster sem
   réplica, ajuste `PG_USE_REPLICA` (passo 4).
3. Quando o PlanetScale oferecer configurar o Hyperdrive, pode pular: o Hyperdrive serve a código que roda no
   próprio Worker; a API do OmniSaúde roda num container e conecta direto no banco.
4. No banco, abra **Connect** e gere a senha do papel padrão (`postgres`). Anote:
   - **host** (algo como `aws-sa-east-1-1.pg.psdb.cloud`);
   - **usuário**, no formato `postgres.<id do branch>`;
   - **senha** (aparece uma vez só).

Esse papel padrão só é usado para criar o que o OmniSaúde precisa: na primeira partida a API cria os papéis
`omni_app` (aplicação) e `omni_bi_reader` (BI somente leitura), o banco `master_auth_db` e um banco por
instituição (`tenant_db_<sigla>`). Use sempre a porta **5432** (as migrações usam travas que não passam pelo
PgBouncer da porta 6432).

## Passo 2: R2 para os documentos

O disco do container é apagado a cada reinício. Sem o R2, documentos enviados (fotos de documentos, anexos)
se perdem.

1. No painel: **R2 Object Storage → Create bucket**, nome `omnisaude-documentos`.
2. Na página do R2, copie o **Account ID**.
3. **Manage API tokens → Create API token**, permissão **Object Read & Write** só nesse bucket. Anote o
   **Access Key ID** e o **Secret Access Key** (aparece uma vez só).

## Passo 3: gerar os segredos (PowerShell)

Cole no PowerShell. Ele só mostra valores aleatórios na tela; nada é enviado a lugar nenhum.

```powershell
function Segredo($bytes) { $b = New-Object byte[] $bytes; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b) }
"JWT_SECRET              = $(Segredo 48)"
"DATA_KEY                = $(Segredo 32)"
"JOBS_SECRET             = $((Segredo 32) -replace '[+/=]', '')"
"APP_DB_PASSWORD         = $((Segredo 24) -replace '[+/=]', '')"
"BI_DB_PASSWORD          = $((Segredo 24) -replace '[+/=]', '')"
"PLATFORM_ADMIN_PASSWORD = Op$((Segredo 18) -replace '[+/=]', '')7"
```

Guarde esses valores num cofre de senhas. A `DATA_KEY` cifra segredos guardados no banco (os certificados A1 dos profissionais, o 2FA dos
usuários): se ela mudar, quem ativou o 2FA precisa configurá-lo de novo. As senhas `APP_DB_PASSWORD` e
`BI_DB_PASSWORD` são aplicadas aos papéis do banco a cada partida da API; trocá-las depois é seguro. A
`PLATFORM_ADMIN_PASSWORD` é a senha da conta de operação da plataforma, que cria e suspende instituições: ela
substitui a senha pública da demonstração nessa conta.

## Passo 4: criar o Worker a partir do GitHub

1. No painel: **Workers & Pages → Create → Import a repository**, conecte o GitHub e escolha
   `mmr-filho/repo-claude`.
2. Configure o build:

   | Campo | Valor |
   |---|---|
   | Project name | `repo-claude` (igual ao `name` de `wrangler.jsonc`; se usar outro nome, mude lá também) |
   | Production branch | `claude/busy-cray-f9aqxw` (não deixe o padrão: o branch padrão do repositório é o do Sigilo, sem a pasta `omnisaude`) |
   | Root directory | `omnisaude` (sem barra) |
   | Build command | `npm ci && npm run build:web -w @omnisaude/cloudflare` |
   | Deploy command | `npx wrangler deploy` (o padrão) |
   | Variável de build | `NODE_VERSION` = `22` |

3. Salve. O primeiro build leva alguns minutos: gera as telas, constrói a imagem da API a partir do
   `Dockerfile` e publica o Worker com a rota `mm.api.br/omnisaude*`.
4. Em **repo-claude → Settings → Variables and Secrets**, adicione como **Secret** (não como texto):

   | Nome | Valor |
   |---|---|
   | `PG_HOST` | host do passo 1 |
   | `PG_ADMIN_USER` | usuário do passo 1 (`postgres.<id>`) |
   | `PG_ADMIN_PASSWORD` | senha do passo 1 |
   | `APP_DB_PASSWORD`, `BI_DB_PASSWORD` | passo 3 |
   | `JWT_SECRET`, `DATA_KEY`, `JOBS_SECRET`, `PLATFORM_ADMIN_PASSWORD` | passo 3 |
   | `PLATFORM_ADMIN_EMAIL` | opcional: seu e-mail como login da plataforma (padrão `plataforma@omnisaude.dev`) |
   | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | passo 2 |
   | `R2_BUCKET` | `omnisaude-documentos` |
   | `ANTHROPIC_API_KEY` | opcional: OCR de documentos, ditado estruturado e BI conversacional |

   Use **Secret** para tudo isso: segredos sobrevivem aos deploys. As variáveis de texto do `wrangler.jsonc`
   (`vars`) são regravadas a cada deploy, e uma variável criada no painel com o mesmo nome seria apagada.

O banco não tem réplica? Em `wrangler.jsonc`, troque `"PG_USE_REPLICA": "true"` por `"false"`
e faça commit (o build roda de novo sozinho).

## Passo 5: domínio

A rota só funciona se `mm.api.br` passar pelo proxy da Cloudflare:

- Em **DNS → Records**, o registro de `mm.api.br` precisa estar **Proxied** (nuvem laranja). Se o endereço já
  atende outro sistema pela Cloudflare, nada muda para ele: o Worker só recebe `/omnisaude*`.
- Se ainda não existe registro para `mm.api.br`, crie um `AAAA` com nome `mm.api.br`, conteúdo `100::` e
  **Proxied** (endereço reservado para "só Workers").
- Se o domínio aparece na Cloudflare com outro nome de zona (por exemplo `api.br`), ajuste `zone_name` em
  `wrangler.jsonc`.

## Passo 6: primeiro acesso

1. Abra https://mm.api.br/omnisaude. A tela de login aparece na hora (são arquivos estáticos).
2. No primeiro login a API sobe e prepara o banco: papéis, `master_auth_db`, a instituição `demo` e as
   migrações. Isso pode levar alguns minutos; enquanto isso a tela mostra "O OmniSaúde está iniciando". Tente
   de novo em instantes.
3. Entre com a instituição `demo`, um CPF da tabela do README e a senha `OmniSaude2026`.

Para conferir: **Workers & Pages → repo-claude → Logs** mostra o Worker e os jobs; em **Containers** ficam a
instância e o log da API (a partida escreve "Papéis e banco master conferidos" e o estado das migrações de
cada instituição).

## Se aparecer "Não encontrado — mm.api.br" (404)

Essa página é do outro sistema que atende `mm.api.br`, não do OmniSaúde: a Cloudflare só manda `/omnisaude`
para o OmniSaúde quando o Worker `repo-claude` está publicado com a rota. Confira, nesta ordem:

1. **Workers & Pages** lista o Worker `repo-claude`? Se não, faça o passo 4.
   O build parou em `Failed: root directory not found`? A Cloudflare clonou um branch sem a pasta
   `omnisaude`: em **repo-claude → Settings → Build → Branch control**, troque o branch de produção para
   `claude/busy-cray-f9aqxw` e confira se o **Root directory** é `omnisaude`. Depois disso, **Retry build** não
   resolve: ele refaz o mesmo commit do branch antigo. O build novo começa com o próximo commit no branch
   `claude/busy-cray-f9aqxw`.
2. Em **repo-claude → Deployments** (ou **Builds**), o último build terminou com sucesso? Se falhou, abra o log:
   a mensagem de erro aparece no fim. Erros comuns:
   - `Containers` não disponível: a conta precisa do plano **Workers Paid**;
   - nome diferente ("Atualize omnisaude/wrangler.jsonc..."): o `name` de `wrangler.jsonc` precisa ser igual ao
     nome do Worker no painel;
   - zona não encontrada: ajuste `zone_name` (passo 5).
3. Em **repo-claude → Settings → Domains & Routes** aparece a rota `mm.api.br/omnisaude*`? Se não, o deploy não
   chegou ao fim.

Quando o Worker está no ar, https://mm.api.br/omnisaude mostra a tela de login do OmniSaúde, mesmo antes de
configurar o banco; sem os segredos, só o login falha, com uma mensagem dizendo o que falta configurar.

## Atualizações e operação

- **Nova versão:** commit no branch de produção. A Cloudflare refaz as telas e a imagem, troca o container e
  a API aplica as migrações pendentes ao subir. Se a migração de uma instituição falhar, as demais continuam
  no ar e o erro fica no log do container.
- **Troca de segredo:** salve no painel. Na próxima requisição o Worker percebe a mudança e reinicia a API com
  os valores novos.
- **Jobs:** os Cron Triggers chamam a API a cada 5 minutos (confirmações do WhatsApp e envio à RNDS) e às
  09:00 UTC (SIGTAP, que só sincroniza no primeiro dia útil do mês). Isso mantém a instância sempre ligada;
  conte com o custo de uma instância `basic` em tempo integral, além do PlanetScale e do R2 (preços atuais
  nas páginas de preço de cada produto).
- **Mais fôlego:** em `wrangler.jsonc`, `instance_type` `"standard-1"` dobra a CPU e quadruplica a memória.
- **Backup:** o PlanetScale faz backups automáticos do cluster; cada instituição tem um banco próprio, o que
  permite restaurar ou exportar uma sem tocar nas outras.
- **Nova instituição:** `POST /omnisaude/api/platform/tenants` com o login da plataforma
  (`POST /omnisaude/api/platform/login`, com `PLATFORM_ADMIN_EMAIL` e `PLATFORM_ADMIN_PASSWORD`).

## Sair do modo demonstração

Em `wrangler.jsonc`, troque `SEED_DEMO` e `DEMO_MOCKS` para `"false"` e configure as
integrações reais como segredos: `WHATSAPP_*`, `RNDS_*`, `SEFAZ_URL`, `SIGTAP_ZIP_URL`. O certificado
ICP-Brasil da RNDS (arquivo `.pfx`) vai para o bucket do R2 (botão **Upload**, por exemplo em
`certificados/rnds.pfx`), com o segredo `RNDS_CERT_PFX` = `r2:certificados/rnds.pfx` e a senha em
`RNDS_CERT_PASSPHRASE`. A instituição `demo` continua no banco: suspenda-a com
`PATCH /omnisaude/api/platform/tenants/<id>` (corpo `{"status": "SUSPENSO"}`).

## Alternativa: publicar do seu computador

Precisa do Node 22 e do **Docker Desktop aberto** (a imagem da API é construída na sua máquina e enviada
para a Cloudflare). Na pasta `omnisaude` do repositório, no PowerShell:

```powershell
npm ci
npx wrangler login
npm run cloudflare:deploy
```

Depois cadastre os segredos do passo 4, um de cada vez:

```powershell
npx wrangler secret put PG_HOST
```

## Limites desta publicação

- A API roda numa instância só: o Socket.IO (painel de chamada, censo de leitos) e a central de intérpretes
  de Libras guardam estado em memória.
- Sem Redis: os jobs rodam pelos Cron Triggers em vez da fila BullMQ.
- Chamadas de vídeo em Libras entre redes diferentes precisam de um servidor TURN (`TURN_URL`,
  `TURN_USERNAME`, `TURN_CREDENTIAL`).
- Para rodar num servidor próprio com Docker Compose, veja [`PUBLICACAO-SERVIDOR.md`](PUBLICACAO-SERVIDOR.md).
