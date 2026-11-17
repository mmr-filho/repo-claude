# Memória retida pelo Prisma 7: o histórico de depuração

O Prisma 7.10.1 guarda em memória os argumentos das últimas 100 chamadas do seu utilitário de depuração, **mesmo com
o `DEBUG` desligado**. Entre esses argumentos estão o plano de cada consulta (com todas as linhas de um `createMany`)
e cada SQL enviado ao Postgres com os parâmetros. No container de produção (1/4 de vCPU, 1 GiB, heap de 512 MB), uma
importação grande deixava centenas de MB presos depois de terminar, e a base de endereços do CNEFE de um município
médio derrubava a API por falta de memória.

A instalação corrige o runtime do Prisma para só guardar esse histórico quando a depuração está ligada. Com isso, as
cargas grandes medidas, que deixavam de 87 a 422 MB retidos, passam a não reter nada (no máximo 0,2 MB), e o pico da
base do CNEFE com 40 mil endereços cai de 475 MB para 106 MB.

## O mecanismo

São duas cópias do mesmo utilitário (`@prisma/debug`), as duas carregadas pela API (conferido pelo `require.cache`):

| | Arquivo | O que entra no histórico |
|---|---|---|
| **A** | `@prisma/client/runtime/client.js` (cópia embutida e minificada: `var Mu=100,…,Lt=[]` e `n.length!==0&&Lt.push([o,...n]),Lt.length>Mu&&Lt.shift()`) | `debug("query plan created", plano)` em toda consulta, e o plano do `createMany` carrega todas as linhas; no SQL cru, a string `prisma.$executeRaw(sql, valores)` com todos os valores, mais o plano |
| **B** | `@prisma/debug/dist/index.js` (`argsHistory`, `MAX_ARGS_HISTORY = 100`), usado pelo `@prisma/adapter-pg` via `@prisma/driver-adapter-utils` | `debug("[js::query_raw] %O", { sql, args, argTypes })` e `[js::execute_raw]` em **toda** consulta: leituras e escritas, com todos os parâmetros |

A gravação acontece antes de o Prisma decidir se imprime; o `DEBUG` só controla a impressão. O histórico só é lido
para montar o link de issue do `PrismaClientRustPanicError` (pânico do compilador de consultas), e só é limpo no
`$disconnect()` (A) ou pelo `clearLogs()` do `@prisma/debug` (B). Na API os clientes de tenant vivem enquanto o
processo vive (LRU), então o que entra no histórico fica até que outras 100 chamadas o empurrem para fora.

Medindo a carga do enunciado (30 mil linhas em `createMany` de 500): 162 MB retidos, dos quais ~100 MB no histórico A
e ~65 MB no B; zerando os dois, nada sobra. Por isso o `INSERT` com parâmetro JSON (técnica da importação da
vigilância, semana 27) ainda retinha: o JSON de cada lote fica na string do SQL cru e no plano (A) e nos parâmetros
do adaptador (B).

## Inventário (medido)

Cada carga rodou num processo filho com `--max-old-space-size=512 --expose-gc`, com o `TenantClient` e o adaptador
`pg` como na API. **Retido** é o heap usado depois da coleta de lixo menos a base medida depois de um aquecimento;
valores até −6 MB aparecem quando a coleta libera algo do aquecimento e devem ser lidos como zero. **Pico** é o maior
heap usado durante a carga. Os modelos e os tamanhos de lote são os do código.

| Caminho | Onde | Padrão | Carga | Retido antes | Pico antes | Retido depois | Pico depois |
|---|---|---|---|---|---|---|---|
| Base de endereços do CNEFE | `modules/territorio/importacao.service.ts` (`aplicarEnderecos`) | `createMany` de 2000 numa transação | 40 mil endereços | **422 MB** | 475 MB | 0 | 106 MB |
| idem | | | 50 mil endereços | **estouro do heap** | — | 0 | 106 MB |
| SIGTAP | `modules/billing/billing.service.ts` (`loadSigtap`) | `createMany` de 5000 numa transação | 150 mil vínculos procedimento × CID | 130 MB | 229 MB | 0 | 99 MB |
| Lote do e-SUS | `modules/esus/esus.service.ts` | `createManyAndReturn` de 500 fichas (com o conteúdo serializado) e `createMany` de 5000 itens | 10 mil fichas | 100 MB | 158 MB | 0 | 94 MB |
| `createMany` genérico (enunciado) | — | lotes de 500 | 30 mil linhas | 162 MB | 277 MB | 0 | 82 MB |
| Leitura e atualização por lista de chaves | vários (`in: ids`, `ANY(${ids}::uuid[])`) | `findMany` e `updateMany` com 30 mil ids, 20 vezes | — | 87 MB | 153 MB | 0 | 80 MB |
| Prévia do CNES | `modules/admin/cnes.service.ts` (`previewProfessionals`, `previewEstablishments`) | a planilha inteira num campo JSON (`cnes_imports.payload`) | 30 mil linhas | 12 MB | 107 MB | 0,2 MB | 109 MB |
| Aplicação do CNES | idem (`applyProfessionals`, `stage`, `applyEstablishments`) | um `create`/`update` por linha | 30 mil linhas | 0 | 100 MB | 0 | 101 MB |
| `INSERT` em SQL com parâmetro JSON | importação da vigilância (semana 27) | `$executeRaw` + `jsonb_to_recordset`, lotes de 250 | 30 mil linhas | 12 MB¹ | 68 MB | 0,1 MB | 57 MB |
| Carga de demonstração | `packages/database/src/seed/demo.ts` | `createMany` pequenos | carga completa | 2 MB | — | — | — |

¹ Com linhas de endereço; com os registros da vigilância (mais colunas e um `jsonb`), a medição do enunciado deu ~33 MB.

Com o mesmo padrão e volumes pequenos hoje: o catálogo da vigilância (`notifiableCodeMap.createMany`), a auditoria em
lote (`appendAuditBatch`) e as listas de quarteirões e imóveis das endemias (`ANY(...)`). A aplicação do CNES não
retém porque cada consulta tem plano em cache (o mesmo objeto) e parâmetros pequenos; o que ela tem de pesado é o
trabalho em si (pico de 100 MB com 30 mil linhas).

## O que existe no upstream

Pesquisa em 17/11/2026 (o repositório `prisma/prisma` agora se chama `prisma/orm`):

- **Issue [prisma/orm#30494](https://github.com/prisma/orm/issues/30494)**, "Debug history keeps query plans alive even
  when DEBUG is off": aberta desde 29/09/2026 (Prisma 7.10.0), sem resposta de mantenedor nem marcador.
- **PR [prisma/orm#30556](https://github.com/prisma/orm/pull/30556)** (da comunidade, base `v7`): aberto e sem revisão.
  Com o `DEBUG` desligado, troca objetos por `[Object]`, mas mantém strings; a string do SQL cru com os valores (A)
  continuaria retida.
- **PR [prisma/orm#16655](https://github.com/prisma/orm/pull/16655)** (2022): foi quem criou o `clearLogs()` no
  `$disconnect()`, para um vazamento parecido em testes. A decisão na época foi limpar ao desconectar, não parar de
  gravar.
- **Não há opção oficial**: o utilitário só lê `DEBUG` e `DEBUG_COLORS`; o `PrismaClient` (`log`,
  `queryPlanCacheMaxSize`, `__internal`…) e o `PrismaPg` não têm nada para isso; o runtime exporta `Debug`, mas não
  `clearLogs`. O `@prisma/debug` exporta `clearLogs()`, mas se declara de uso interno e fora do SemVer.
- **Nenhuma versão publicada depois da 7.10.1 muda isso**: só saíram builds `8.1.0-dev.*`, e na `8.1.0-dev.12` o
  `push` continua incondicional (runtime e `@prisma/debug`, este idêntico byte a byte ao da 7.10.1) e o adaptador
  continua registrando `{ sql, args, argTypes }`. O Prisma 8 (`prisma@8.0.0-rc.*`, pacotes `@prisma/orm-*`) não tem
  esse utilitário, mas adotá-lo é uma migração de API, não uma correção.

## Decisão: correção do runtime na instalação

Das três saídas, a mais segura é a correção na instalação:

- **Cobre os dois históricos e todos os caminhos**, inclusive leituras com listas grandes e caminhos que ainda não
  existem, sem mexer em nenhum serviço. Também derruba o **pico**: a base do CNEFE de 50 mil endereços passa de estouro
  do heap para 106 MB.
- **Lotes menores ou SQL com JSON** (opção b) trata caminho por caminho, não alcança o histórico B nas leituras, ainda
  retém (12 a 33 MB por caminho) e obrigaria a reescrever `createMany` tipados em SQL. Fica como técnica opcional, não
  como contenção.
- **Saída do upstream** (opção c) não existe hoje. Limpar depois da carga (`$disconnect` num cliente descartável para
  A, `clearLogs` do `@prisma/debug` para B) também depende de comportamento interno e não limita o pico, que é o que
  derruba o processo. Quando o upstream corrigir, a correção local sai (abaixo).

Como o risco da correção é ficar fora de sincronia com o Prisma, ela foi feita para falhar alto:

- troca **um trecho exato** (expressão regular sobre as duas formas publicadas na 7.10.1) e deixa uma marca
  (`/*omnisaude:prisma-sem-historico*/`); rodar de novo não muda nada, e o arquivo é gravado ao lado e renomeado;
- a condição nova é **a mesma que o Prisma usa para imprimir** (`DEBUG` cobrindo o namespace): com o `DEBUG` ligado o
  comportamento é idêntico ao original, histórico inclusive;
- o **Dockerfile** roda a correção com `--exigir` depois do `npm ci` de produção: sem ela a imagem não sai;
- o **teste** falha se a correção não estiver aplicada, se o trecho não for achado (atualização do Prisma) ou se as
  cargas passarem do teto;
- a **API avisa na partida** (log `Prisma`, em `core/database.ts`) se carregar o runtime sem a correção.

Efeito colateral: com o `DEBUG` desligado, o link de issue do `PrismaClientRustPanicError` vem sem a seção de logs. Isso
também impede que dados de pacientes (planos e parâmetros) acabem embutidos numa mensagem de erro e nos logs.

## Como funciona

- `packages/database/scripts/prisma-sem-historico.cjs` resolve os arquivos como o Node os carrega a partir de
  `packages/database`. **Obrigatórios** são os dois que a API carrega: `@prisma/client/runtime/client.js` e o
  `@prisma/debug` do adaptador (`adapter-pg` → `driver-adapter-utils` → `debug`). Os irmãos ESM e edge
  (`client.mjs`, `wasm-compiler-edge.js`/`.mjs`, `debug/dist/index.mjs`) são corrigidos quando existem. As cópias do
  CLI do Prisma (`prisma/build`, `@prisma/config`, `@prisma/get-platform`) não são tocadas: não rodam na API.
- Roda no `postinstall` da raiz do monorepo. Se não achar o trecho num arquivo obrigatório, avisa e deixa a instalação
  seguir (o teste falha). No Dockerfile, o estágio `deps` copia o script antes do `npm ci`, e o `prod-deps` (de onde
  sai o `node_modules` da imagem da API) roda `--exigir`.
- `prismaComHistoricoDeDepuracao()` (`packages/database/src/prisma-historico.ts`) devolve os arquivos obrigatórios
  ainda sem a correção, com a orientação do que fazer; a API usa na partida.

## Como conferir

```bash
cd omnisaude
node packages/database/scripts/prisma-sem-historico.cjs --verificar
OMNI_TEST_SUFFIX=memoria npx vitest run --project api apps/api/test/prisma-memoria.test.ts
```

O teste (`apps/api/test/prisma-memoria.test.ts`) tem cinco partes: a correção aplicada nos arquivos obrigatórios; a
transformação nas duas formas do trecho (guarda só com o `DEBUG` ligado e, ligado, se comporta como o original); o
`@prisma/debug` instalado sem nada no `getLogs()` com o `DEBUG` desligado; o runtime do cliente sem os ~90 MB que 100
chamadas de 900 KB prenderiam; e o **teto de memória**: num processo filho com `--max-old-space-size=512`, cinco cargas
de 30 mil linhas cada (`createMany` de 500, `createMany` de 2000 numa transação como no CNEFE, prévia do CNES com a
planilha em JSON, `findMany`/`updateMany` com 30 mil chaves e `INSERT` com parâmetro JSON) precisam deixar menos de
40 MB retidos cada (`apps/api/test/prisma-memoria-carga.ts`). Sem a correção, o processo filho estoura o heap de
512 MB antes de terminar as cargas. A última parte precisa do Postgres de desenvolvimento (porta 54329); sem ele, é
pulada.

## Ao atualizar o Prisma

1. `npm install` roda a correção. Se aparecer `TRECHO NÃO ENCONTRADO`, o Prisma mudou o código.
2. Veja se o histórico ainda existe na versão nova: no runtime, procure `["green","yellow","blue","magenta","cyan","red"]`
   e o `push` logo depois em `node_modules/@prisma/client/runtime/client.js`; no utilitário, `argsHistory` em
   `node_modules/@prisma/debug/dist/index.js`.
3. Se o `push` continua incondicional, ajuste `TRECHOS` no script para o formato novo e rode o teste.
4. Se o upstream passou a guardar só com o `DEBUG` ligado (ou removeu o histórico), apague o script, o `postinstall`,
   as duas linhas do Dockerfile, `prisma-historico.ts` e o aviso da partida, e as três partes do teste que olham os
   arquivos. **Mantenha o teto de memória**: ele confirma que a correção do upstream resolve.
5. Acompanhe [prisma/orm#30494](https://github.com/prisma/orm/issues/30494).

A importação da vigilância (semana 27) explica o `INSERT` com parâmetro JSON dizendo que assim "o Prisma não guarda os
dados no histórico do debug". Não era bem assim (o JSON ficava nos dois históricos, os ~33 MB medidos); com a correção
deixa de importar, e o lote de 250 pode ficar como está.
