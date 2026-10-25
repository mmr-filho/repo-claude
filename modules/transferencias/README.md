# Módulo Transferências Federais: inteligência e otimização de repasses por prefeitura

Para **uma prefeitura do Tocantins de cada vez**, mostra três coisas:

- onde ela perde ou pode ganhar repasses federais em educação, saúde e assistência social;
- quanto isso vale em reais por mês e por ano;
- o passo a passo para corrigir: responsável técnico, sistema oficial, ação corretiva e prazo.

Feito para entrar no `mm.api.br` com o visual, o layout e a sessão do site.

Plano, matriz de viabilidade e bloqueios: [`docs/TRANSFERENCIAS-MODULO-PLANO.md`](../../docs/TRANSFERENCIAS-MODULO-PLANO.md).

## As quatro camadas

| Camada | Arquivo | Saída |
|---|---|---|
| 1. ETL (dados abertos do Tesouro) | `etl/coleta_siconfi.py` | `dados/perfil/perfil_municipio_<ibge>.json` |
| 2. Motor de regras | `src/regras.ts`, `src/pares.ts` | `dados/analise/<ibge>.json`, `dados/indice.json`, `dados/pares.json` |
| 3. RAG (normas) | `etl/corpus.py`, `src/rag.ts` | `dados/rag/chunks.json` (trechos Lei › Capítulo › Seção › Artigo › Parágrafo) |
| 4. Agente | `src/prompt.ts` (system prompt literal), `src/agente.ts` | parecer no formato dos cards, conferido contra o motor |

A API (`src/api.ts`) é a mesma no Node (`src/node-server.ts`) e no Cloudflare Workers (`src/worker.ts`).

## Rodar

```bash
npm install                                   # na raiz do repositório
npm run dev -w @mm/transferencias             # http://localhost:8090/ (página + API)
```

Sem `TF_SEGREDO_SESSAO`, a API só atende pedidos da própria máquina (desenvolvimento). Sem `ANTHROPIC_API_KEY`, o parecer é o texto do motor de regras. A página também abre sem servidor de API: sirva a pasta por HTTP (`python3 -m http.server`) e ela lê `dados/`.

## Atualizar os dados

Só biblioteca padrão do Python:

```bash
npm run coletar -w @mm/transferencias -- --ano 2026    # Siconfi, 139 prefeituras (~25 min)
npm run corpus  -w @mm/transferencias                  # normas do normas.leg.br (usa corpus/.cache)
npm run analisar -w @mm/transferencias                 # motor de regras → dados/analise, indice, pares
```

Sugestão de agenda no servidor: coleta no dia 5 de cada mês (depois da entrega da MSC do mês anterior), seguida de `analisar`.

### O perfil (`perfil_municipio_<ibge>.json`)

| Campo | Conteúdo |
|---|---|
| `rreo14.<ano>` | bimestre, se é simplificado, RCL e, para `mde`, `fundeb70`, `asps`: `aplicado_pct`, `minimo_pct`, `valor`. O RREO simplificado não traz os percentuais. |
| `rgf5` | disponibilidade de caixa por linha de vinculação no fim do ano anterior: `bruta`, `liquida`, `liquida_apos_rp` |
| `receitas.<ano>` | receita realizada (conta 6.2.1.2 da MSC), em R$, por fonte de recursos (`540`, `600`, `660`…) e, para transferências, por natureza de receita; `meses` = meses cobertos |
| `caixa` | caixa e equivalentes (contas 1.1.1.1), débito menos crédito, por fonte, no último mês da MSC |
| `faltas` | o que não veio do Tesouro |

Fontes de recursos: 3 dígitos da tabela padronizada da STN. A MSC prefixa 1 (exercício) ou 2 (exercícios anteriores), e o módulo soma os dois.

## Regras

Parâmetros que não vêm de lei citada estão em `PARAMETROS` (`src/regras.ts`), com a origem de cada um.

| Regra | Nível | Impacto |
|---|---|---|
| Mínimos (FUNDEB 70%, MDE 25%, saúde 15%) | Crítico se o ano encerrado ficou abaixo; Alerta se o ano corrente está abaixo | valor a aplicar; no ano corrente, também o ritmo por mês até dezembro |
| Saldo do FUNDEB acima de 10% no fim do ano | Crítico | o que passou de 10% |
| VAAR que parou de chegar | Alerta | perda: o VAAR do ano anterior |
| VAAR nunca recebido | Oportunidade | potencial: mediana VAAR ÷ FUNDEB dos pares × FUNDEB da prefeitura |
| Saldo do FNAS em meses de repasse | Crítico ≥ 12; Alerta ≥ 6 | repasse mensal que pode ser suspenso |
| Recurso do SUS parado | Oportunidade | saldo acima de 3 meses de repasse |
| FUNDEB, PNAE, PNATE, SUS e FNAS por habitante | Oportunidade, confiança baixa | distância até a mediana do grupo. É um sinal para investigar, não valor devido. Só em grupos de 15 ou mais prefeituras, no quartil inferior e ao menos 25% abaixo da mediana. |

O que os dados abertos não mostram vira **pendência**, com onde conferir e quem confere: Educacenso, SIMEC, SCNES, e-SUS APS, IGD, CadSUAS.

## Agente (camada 4)

- **Modelo**: `claude-opus-5-5`, com pensamento adaptativo e esforço `high`. O system prompt da especificação é usado literalmente (`src/prompt.ts`; um teste confere o hash) e fica em cache.
- **Saída estruturada**: JSON Schema (`ESQUEMA_SAIDA`) com os campos dos cards: `eixo`, `nivel_criticidade`, `diagnostico_direto`, `impacto_financeiro`, `base_legal` e `passo_a_passo_operacional` (responsável, sistema, ação, prazo).
- **Fallback do servidor** ligado (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`). Para desligar, retire essas duas linhas em `parecer()`.
- **Entrada**: `[DADOS_MUNICIPIO]` (achados do motor) e `[CONTEXTO_NORMATIVO_RAG]` (trechos citados mais os vizinhos da busca BM25).
- **Conferência** (`confere`): valor em R$, percentual ou norma que não esteja no achado, nas normas enviadas ou no system prompt é trocado pelo texto do motor. Citação fora do contexto sai. Achado sem bloco recebe o bloco do motor; bloco sem achado é descartado. Cada troca fica em `ajustes`, que a página mostra.
- **Falhas**: recusa, resposta cortada, formato errado ou rede. O usuário recebe o texto do motor, com o aviso.

Variáveis: `ANTHROPIC_API_KEY`, `TF_MODELO` (padrão `claude-opus-5-5`), `TF_ESFORCO` (`low` a `max`; padrão `high`).

## API e sessão do site

| Método | Caminho | Resposta |
|---|---|---|
| `GET` | `/api/transferencias/municipios` | lista com o resumo, só das prefeituras da sessão |
| `GET` | `/api/transferencias/{ibge}` | análise do motor |
| `GET` | `/api/transferencias/{ibge}/parecer` | último parecer; `404` se não há |
| `POST` | `/api/transferencias/{ibge}/parecer` | gera o parecer (corpo `{}` ou `{"refazer": true}`); exige `content-type: application/json` e mesma origem; `429` acima de 10 por hora por usuário |

O módulo não tem login: confia na sessão que o middleware do mm.api.br (Cloudflare / API Gateway) repassa em dois cabeçalhos, assinados com o segredo compartilhado `TF_SEGREDO_SESSAO` (32 caracteres ou mais):

```
x-mm-sessao:     base64url({"u": "usuario@prefeitura", "m": [1721000] ou "*", "g": true, "exp": <unix>})
x-mm-assinatura: base64url(HMAC-SHA256(TF_SEGREDO_SESSAO, x-mm-sessao))
```

- `m`: prefeituras que o usuário vê.
- `g`: se pode gerar parecer, o que consome a API do modelo.
- `exp`: validade curta.

`assinaSessao()` em `src/auth.ts` mostra como montar os cabeçalhos. O gateway deve remover esses cabeçalhos quando vêm do navegador.

Na página do site, a API se liga por `<main id="tf-app" data-api="/api/transferencias">`. Com isso, lista e análise vêm da API (com a sessão) e aparece o bloco "Parecer do consultor".

### Cloudflare Workers

`wrangler.jsonc` publica a página e `dados/` como arquivos estáticos; `.assetsignore` deixa de fora o código, os perfis e os pareceres. Os pareceres ficam no KV `PARECERES`.

```bash
cd modules/transferencias
npx wrangler kv namespace create PARECERES      # copie o id para wrangler.jsonc
npx wrangler secret put TF_SEGREDO_SESSAO
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler deploy
```

## Testes

```bash
npm test -w @mm/transferencias          # regras, RAG, agente (cliente simulado), API e sessão
npm run test:e2e -w @mm/transferencias  # a página no Chromium, sob a política de segurança do site
npm run typecheck -w @mm/transferencias
```

Os testes não chamam a API do modelo: o cliente é simulado e confere o pedido (modelo, system prompt em cache, saída estruturada, fallback) e a conferência do texto.

## Visual

O CSS do site vem inline (a política só aceita `style-src 'unsafe-inline'`). `index.html` leva um recorte dele, com as classes usadas, entre `/* mm-base:início */` e `/* mm-base:fim */`. São as mesmas peças do site:

- topo e navegação;
- KPIs;
- cards `est-req`;
- chips e filtros;
- tabela;
- gaveta lateral.

Para atualizar quando o site mudar:

```bash
curl -sL https://mm.api.br/login -o login.html
python3 ../transparencia/tools/extrai_css_base.py login.html .
```

Aparências Claro, Escuro e Terminal, como no site. O seletor do topo é só da página de teste.

## Limites

- Os números dependem da contabilidade enviada ao Tesouro: fonte de recursos mal classificada aparece como gargalo. Por isso cada card traz "Como foi calculado" e a confiança.
- O RREO simplificado (cerca de 120 prefeituras) não traz os percentuais mínimos; ficam como pendência (SIOPE e SIOPS).
- O módulo ainda não lê ponderação do Educacenso, equipes do SCNES, cadastros do e-SUS APS nem índices do SUAS: dependem de acesso restrito ou de hosts bloqueados neste ambiente (veja o plano).
- Portarias fora do normas.leg.br, como a Portaria MDS nº 113/2015, aparecem como "a conferir" até entrarem em `corpus/locais/`. O formato é um `.txt` com cabeçalho `sigla:`, `rotulo:` e `url:`, uma linha em branco e o texto com `Art.`, `§` e incisos.
