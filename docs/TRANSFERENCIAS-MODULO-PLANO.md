# Módulo de Inteligência e Otimização de Transferências Federais: plano e viabilidade

Para cada uma das 139 prefeituras do Tocantins, o módulo mostra onde a prefeitura perde repasses federais em educação, saúde e assistência social e onde pode ganhar mais. Mostra também quanto isso vale em reais por mês e por ano e o passo a passo para corrigir: responsável, sistema oficial, ação e prazo. Ele entra no mm.api.br como módulo nativo e usa o mesmo visual, layout e sessão do site.

Código e uso: [`modules/transferencias/README.md`](../modules/transferencias/README.md).

## Situação (25/10/2026)

| Camada | Estado | O que tem |
|---|---|---|
| 1. ETL | **Pronto** | `perfil_municipio_<ibge>.json` das 139 prefeituras, a partir do Siconfi (RREO Anexo 14, RGF Anexo 5, Matriz de Saldos Contábeis). Não houve falha de coleta. A MSC vai até agosto/2026 em 118 delas. |
| 2. Motor de regras | **Pronto** | 9 regras com parâmetro legal ou comparação com pares do mesmo porte. Cada achado tem impacto em R$/mês e R$/ano, método de cálculo, confiança, base legal e passo a passo. |
| 3. RAG | **Pronto** | Corpus de 394 trechos de 10 normas, obtidos no normas.leg.br e fatiados em Lei › Capítulo › Seção › Artigo › Parágrafo. Busca exata por id mais BM25. |
| 4. Agente | **Pronto, sem chave em produção** | System prompt literal da especificação, saída estruturada no formato dos cards e conferência automática de valores, percentuais e normas. Sem chave, a API devolve o texto do motor. |
| Interface | **Pronta** | Telas de escolha, panorama com KPIs e cards, gaveta com o texto da norma, receitas com tabela paginada, relatório e metodologia. Três aparências e celular. |
| Integração com o site | **Contrato definido** | Sessão por cabeçalho assinado (HMAC) vinda do middleware do mm.api.br. A API é a mesma em Node e no Cloudflare Workers. |

Resultado da primeira rodada sobre os dados do Tesouro:

- **Totais**: 35 achados críticos, 68 alertas e 180 oportunidades; 32 prefeituras têm ao menos um crítico.
- **Por categoria**:
  - R$ 21,5 milhões por ano em repasses em risco (FNAS com saldo parado e VAAR que parou de chegar);
  - R$ 32,5 milhões a aplicar para cumprir mínimos legais;
  - R$ 129 milhões de recurso federal do SUS parado acima de 3 meses de folga, nas 33 prefeituras com saldo acima do padrão do grupo.
- **Destaques**:
  - **24 prefeituras** receberam a complementação VAAR do FUNDEB em 2025 e nada em 2026 até agosto.
  - **27** têm saldo do FNAS acima de 12 meses de repasse.

## Matriz de viabilidade: regras da especificação × dados

Legenda:

- **Implementado**: calculado com dado aberto.
- **Pendência guiada**: o módulo indica onde e quem confere, mas o dado não é aberto.
- **Bloqueado**: precisa de acesso que este ambiente não tem.

| Eixo | Regra da especificação | Situação | Fonte usada ou necessária |
|---|---|---|---|
| Educação | FUNDEB 70% na remuneração (Lei 14.113/2020, art. 26) | **Implementado** para quem publica o RREO completo (18 prefeituras): crítico no ano encerrado, alerta no ano corrente com o ritmo mensal | RREO Anexo 14. O RREO simplificado não traz o percentual; para essas, o dado está no SIOPE, cujo site está fora do ar ou bloqueado |
| Educação | MDE 25% (CF, art. 212) | **Implementado** (mesma ressalva) | RREO Anexo 14 |
| Educação | Saldo do FUNDEB acima de 10% no fim do ano (art. 25, § 3º) | **Implementado** | RGF Anexo 5 × receita do FUNDEB na MSC |
| Educação | VAAR: 5 condicionalidades e SAEB de 80% | **Implementado pelo efeito**: detecta quem parou de receber (perda) ou nunca recebeu (potencial pela mediana dos pares). A condicionalidade específica fica como **pendência guiada** | Fonte 543 na MSC. A lista de habilitados por condicionalidade está no FNDE/SIMEC |
| Educação | Ponderação do Educacenso (integral, AEE, creche, campo) | **Sinal + pendência guiada**: FUNDEB, PNAE e PNATE por habitante abaixo do quartil inferior do grupo, sempre com confiança baixa | Cálculo exato exige as matrículas por etapa e jornada (INEP: `download.inep.gov.br` está bloqueado aqui) e os fatores do ano |
| Educação | PNAE e PNATE | **Sinal** por habitante (Lei 11.947, art. 5º, § 4º; Lei 10.880, art. 2º) | MSC, fontes 552 e 553 |
| Saúde | ASPS 15% (LC 141/2012, art. 7º) e condicionamento da entrega (art. 26; CF, art. 160) | **Implementado** (mesma ressalva do RREO simplificado; o dado alternativo é o SIOPS) | RREO Anexo 14 |
| Saúde | Equipes homologadas × pagas, suspensões (médico 40h ausente > 60 dias) | **Pendência guiada** | SCNES e relatórios de pagamento da APS: `apidadosabertos.saude.gov.br` e os serviços do CNES estão bloqueados ou fora do ar |
| Saúde | e-SUS APS: cadastros > 24 meses, CPF/CNS, PBF/BPC, metas de qualidade | **Pendência guiada**; o passo a passo do sinal por habitante lista essas conferências | e-SUS APS/SISAB (acesso de gestor) |
| Saúde | MAC: subfaturamento SIA/SIH, SIGTAP | **Sinal** (SUS manutenção por habitante) + pendência | Produção SIA/SIH (DATASUS bloqueado aqui) |
| Saúde | Recurso do SUS parado | **Implementado** (oportunidade, acima do maior entre 6 meses e o 3º quartil do grupo) | MSC: caixa da fonte 600 × repasse médio |
| Assistência | Bloqueio por saldo acima de 12/24 meses de repasse | **Implementado**: crítico a partir de 12 meses, alerta a partir de 6 | MSC: caixa da fonte 660 × repasse médio de 2025. A Portaria MDS 113/2015 não está no corpus (in.gov.br bloqueado) e aparece como "a conferir" |
| Assistência | IGD-PBF (TAC, condicionalidades), IGD-SUAS (IDCRAS/IDCREAS), RMA, CadSUAS | **Sinal** (FNAS por habitante) + pendência guiada | Painéis do MDS (aplicações redirecionando para aviso de manutenção) |
| Assistência | Conselho, fundo e plano (LOAS, art. 30) | **Pendência guiada** | CadSUAS |

## Decisões de projeto

- **Os números são só do motor; o modelo só redige.** O agente recebe os achados prontos e não cria gargalos. Antes de publicar, `confere()` checa três coisas:
  - todo valor em R$ deve estar no achado, com tolerância para a forma "R$ 1,2 milhão";
  - todo percentual deve estar no achado ou nas normas enviadas;
  - toda norma citada deve estar no contexto, nas normas externas da regra ou no system prompt.

  O que falha é trocado pelo texto do motor e listado em `ajustes`, que aparece na tela. Isso implementa o "ZERO ALUCINAÇÃO" sem depender só da instrução.
- **System prompt literal.** Fica em `src/prompt.ts`, igual byte a byte à seção 4 da especificação, e um teste confere o hash. As instruções de formato desta tarefa vão na mensagem do usuário, para o prompt aprovado não mudar e continuar em cache.
- **Modelo**: Claude Opus 5.5 (`claude-opus-5-5`), configuração do agente:
  - pensamento adaptativo e esforço `high`;
  - saída estruturada (JSON Schema no formato dos cards);
  - system prompt em cache;
  - fallback do servidor ligado (`fallbacks: "default"`): se o modelo recusar por política, a própria API repete no modelo recomendado; se ainda assim falhar, o prefeito recebe o texto do motor.

  Modelo e esforço são configuráveis (`TF_MODELO`, `TF_ESFORCO`).
- **Comparação com pares.** O grupo é a faixa populacional. As faixas com poucas prefeituras no Tocantins (20 mil a mais de 100 mil) se juntam num grupo, que não entra na comparação por habitante por ser heterogêneo demais (de 20 mil a 330 mil habitantes).
- **Fontes padronizadas da STN.** Os códigos são conferidos na tabela FontePadraoSTN. A MSC separa recursos do exercício (1xxx) e de anteriores (2xxx); o módulo soma os dois e líquida débito e crédito por conta.
- **Sem custo para abrir a página**: a análise é estática. O agente só roda quando um usuário com permissão pede um parecer, e há limite por hora.

## Bloqueios e o que é preciso decidir

1. **Chave da API da Anthropic no servidor** (`ANTHROPIC_API_KEY`, como segredo do Worker ou variável do Node). Sem ela, o parecer é o texto do motor.
2. **Middleware do mm.api.br**: assinar a sessão nos cabeçalhos `x-mm-sessao` e `x-mm-assinatura`, com o segredo compartilhado `TF_SEGREDO_SESSAO`. O formato está no README. Também é preciso definir quem tem `pode_gerar`.
3. **Rede do ambiente de coleta**: liberar os hosts abaixo para ligar as regras que hoje são pendência.
   - `download.inep.gov.br` (sinopse do Censo Escolar);
   - `apidadosabertos.saude.gov.br`, serviços do CNES, DATASUS/TabNet;
   - `in.gov.br` e `planalto.gov.br` (portarias no corpus);
   - `www.fnde.gov.br/siope` e SIOPS (percentuais das prefeituras com RREO simplificado);
   - `tesourotransparente.gov.br` (limite de acesso).
4. **Dados com acesso restrito**: exportações do SCNES local, e-SUS APS, Educacenso, CadÚnico, RMA. Exigem acordo com as prefeituras (LGPD: só agregados, sem dado pessoal).
5. **Portarias fora do normas.leg.br** (GM/MS 3.493/2024, PC 6/2017, MDS 113/2015, resoluções do FNDE). Entram como texto em `corpus/locais/`, e as regras passam a citá-las.

## Próximas fases

1. Importadores dos dados municipais e as regras exatas:
   - ponderação do Educacenso com os fatores do ano;
   - equipes do SCNES homologadas × pagas;
   - cadastros do e-SUS;
   - IGD.
2. Corpus com as portarias e cartilhas, e as regras citando os parágrafos delas.
3. Coleta agendada no servidor (ex.: Siconfi no dia 5 de cada mês) e histórico mês a mês do saldo parado.
4. Avaliação do agente: um conjunto de pareceres revisados por técnicos de cada área, antes de abrir para todas as prefeituras.
