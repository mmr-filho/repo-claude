# Módulo Transparência Municipal (Tocantins): pesquisa e plano de ação

Atualizado em 24/10/2026, depois de liberada parte da rede. A primeira versão deste documento (só com resumos de busca) foi substituída: agora os números vêm da **base aberta do PNTP**, da **Cartilha PNTP 2026** (299 páginas) e da **matriz de critérios 2026**, todas baixadas e lidas.

O protótipo do módulo, com dados reais, está em [`modules/transparencia/`](../modules/transparencia/README.md).

## 0. Em resumo

1. **O Tocantins já é líder nacional em transparência municipal.** Foi o 1º estado em 2023 e é o 2º em 2024 e 2025, atrás do Pará. Em 2025, **78 das 139 prefeituras têm Selo Diamante (56%)** e 123 têm algum selo (88%), contra 7% e 26% no Brasil.
2. **O trabalho, portanto, não é "tirar do zero", e sim**: levar as 16 sem selo ao selo; **não perder** quem já tem (13 prefeituras caíram de nível em 2025, 7 delas de Diamante); preparar a mudança de regra de 2026; e as câmaras municipais, que ficam atrás das prefeituras.
3. **Dá para verificar cada município**, com dado oficial: a Atricon publica a base completa em dados abertos, por ente, com índice, nível, % de essenciais, link do portal e as respostas critério a critério.
4. **Dá para simular a nota.** Reproduzi o índice oficial de cada prefeitura a partir das respostas com erro médio de **0,01 ponto** (138 de 139 idênticas). Com isso o módulo mostra, para cada prefeitura, **o menor caminho até o Diamante**.
5. **O visual do `mm.api.br` foi obtido** (a tela de login é pública e traz o CSS do site) e o protótipo o reutiliza. Falta ver as telas internas, que exigem login.

## 1. Selo Diamante: o que a Atricon exige

Fonte: Cartilha PNTP 2026 e matriz de critérios 2026 (arquivos oficiais). O PNTP une a **autoavaliação** da prefeitura com a **validação** por auditores do tribunal de contas, no sistema Avalia, e uma revisão amostral da Atricon. O resultado vai para o Radar da Transparência Pública.

### Níveis

| Nível | Índice | Requisito adicional |
|---|---|---|
| **Diamante** | 95% a 100% | 100% dos critérios essenciais |
| Ouro | 85% a 94% | 100% dos essenciais |
| Prata | 75% a 84% | 100% dos essenciais |
| Elevado | acima de 75% | menos de 100% dos essenciais |
| Intermediário | 50% a 74% | n/a |
| Básico | 30% a 49% | n/a |
| Inicial | 1% a 29% | n/a |
| Inexistente | 0% | n/a |

Conferi essa regra contra os níveis oficiais dos três ciclos: **830 de 834** avaliações (prefeituras e câmaras do TO) coincidem. As 4 diferentes: 3 "Não Avaliado" e 1 câmara com 100% rebaixada pela revisão.

**Portão dos essenciais.** Quem falha em **um** item essencial perde o selo, mesmo com 98%: cai para "Elevado". **Tabocão (TO)**, por exemplo, tem 97,2% e é só "Elevado" porque faltam 2 critérios essenciais; corrigidos, a projeção é 99,7%.

**"Inexistente" (0%)** é o resultado de quem não tem sítio oficial próprio ou o tem fora do ar nas tentativas de avaliação (critério 1.1, que prejudica todos os demais, segundo a Cartilha).

### Como o índice é calculado

Peso da **dimensão** × peso do **critério** × peso do **item de verificação**:

- Critério: essencial **2**, obrigatório **1,5**, recomendado **1**, dentro da dimensão, de modo que a soma dos critérios feche o peso da dimensão.
- Item de verificação: disponibilidade **30%**, atualidade **30%**, série histórica **20%**, gravação de relatórios **10%**, filtro de pesquisa **10%**; os que não se aplicam são rateados entre os demais.
- Dimensões (peso): Receita 4, Despesa 4, Planejamento e prestação de contas 4, Recursos humanos 3, Licitações 3, Contratos 3, Informações prioritárias 2, Informações institucionais 2, Obras 2, SIC 2, e peso 1 para convênios, diárias, acessibilidade, ouvidoria, LGPD, renúncia de receita, emendas, saúde e educação.

### Critérios para a prefeitura (matriz 2026)

**181** critérios no total, mas a prefeitura responde a **96** (72 da matriz comum, 23 do Executivo e 1 do Executivo e consórcios): **12 essenciais, 65 obrigatórios, 19 recomendados**. (Em 2025 eram 91 critérios e 11 essenciais.)

Os **essenciais** são os da execução orçamentária e financeira, porque a Lei de Responsabilidade Fiscal (arts. 48, 48-A e 51) impede de receber **transferências voluntárias** e contratar **operações de crédito** quem não os divulga. Ou seja, vale mais que o selo:

| ID | Essencial |
|---|---|
| 1.1, 1.2 | Sítio oficial próprio; portal da transparência |
| 3.1, 3.2 | Receitas (previsão e realização); classificação orçamentária da receita |
| 4.1, 4.2, **4.3** | Despesas (empenhadas, liquidadas, pagas); por classificação; **consulta de empenhos com credor, bem ou serviço e procedimento licitatório** |
| 11.5, 11.6 | RGF; RREO |
| 11.8, 11.9, 11.10 | PPA; LDO; LOA, com anexos |

### O que muda em 2026

- **O critério 4.3 passa de obrigatório a essencial** (confirmado na matriz). Duas prefeituras com selo hoje ainda não o atendem integralmente: **Araguaína** (Prata) e **Ponte Alta do Bom Jesus** (Ouro).
- **Filtro de pesquisa por critério** (vale 10% da nota do critério). A Cartilha define como o instrumento em que o usuário escolhe parâmetros e refina a consulta, diferente da busca geral do portal; em alguns critérios há **filtros mínimos exigidos**, e ele é dispensado quando os dados cabem numa única página. O material de treinamento do TCE-PI acrescenta que o `Ctrl+F` deixa de valer como forma de busca e cita receita, despesa, diárias, convênios, licitações e contratos; **essa parte não aparece na Cartilha**.
- **Não há atendimento parcial**: o critério só conta como atendido quando todas as informações exigidas na disponibilidade estão no portal (Cartilha). É por isso que o simulador trabalha por critério.
- A página do PNTP informa que o ciclo 2026 está na etapa de treinamento da garantia da qualidade e que **os resultados serão divulgados em novembro, no Rio de Janeiro**. O ciclo 2025 foi divulgado em dezembro de 2025.

## 2. Onde o Tocantins está

Prefeituras (139 em todos os ciclos). Fonte: base aberta do PNTP.

| Nível | 2023 | 2024 | 2025 |
|---|---:|---:|---:|
| Diamante | 30 | 47 | **78** |
| Ouro | 7 | 14 | 36 |
| Prata | 2 | 6 | 9 |
| Elevado | 4 | 10 | 3 |
| Intermediário | 71 | 37 | 9 |
| Básico | 22 | 3 | 1 |
| Inicial | 3 | 0 | 3 |
| Inexistente / Não avaliado | 0 | 20 / 2 | 0 |
| **Índice médio** | 68,4% | 71,1% | **90,1%** |

**Ranking entre os estados** (prefeituras): 1º em 2023, 2º em 2024, **2º em 2025** (56,1% Diamante, atrás do Pará com 66%). Brasil em 2025: 5.569 prefeituras, 7,1% Diamante, 25,8% com selo, índice médio 67,5%.

### Onde está o risco e a oportunidade

- **16 prefeituras sem selo**: Tabocão (Elevado, 97,2%), Aguiarnópolis (Elevado, 93,7%), Esperantina (Elevado), 9 em Intermediário, Porto Nacional (Básico, 45,4%), Riachinho, Xambioá e Praia Norte (Inicial).
- **13 prefeituras caíram de nível** em 2025; 7 eram Diamante. Entre elas, duas das maiores cidades: **Araguaína** (183 mil hab.; de 97,6% para 78,2%, agora Prata) e **Gurupi** (90 mil; de Diamante para Ouro, 93,9%). **Porto Nacional** (70 mil, a 4ª maior) está em Básico (45,4%). **Só 24 prefeituras foram Diamante nos três ciclos.**
- **29 prefeituras Diamante estão com menos de 97%**: margem curta contra uma revisão ou uma mudança de regra.
- **"Quase lá"**: Almas, Maurilândia do Tocantins, Araguatins, Juarina e Gurupi são Ouro e chegam ao Diamante corrigindo **1 critério** cada.
- **Câmaras municipais**: 73 Diamante em 139 (índice médio 87,2%), contra 56% das prefeituras; 66 não são Diamante. O PNTP as avalia à parte, com outra matriz. Já estão nos dados do módulo, ainda sem tela própria.
- **O que mais falha no estado** (prefeituras com algum item faltando em 2025): plano estratégico institucional (72, recomendado), plano de contratações anual (69, recomendado), relatório de gestão ou atividades (53, obrigatório) e, entre os **essenciais**, **RGF (11 prefeituras), RREO (9) e receitas (6)**.

## 3. Como verificar cada município

Três camadas, que nunca devem aparecer misturadas na tela:

| Camada | O que é | Situação |
|---|---|---|
| **A. Oficial** | Nível, índice e essenciais de cada ente, por ciclo, com link do portal | **Resolvida.** Base aberta do PNTP (2022 a 2025), um arquivo por ciclo; **já está no protótipo** |
| **B. Sonda automática** | Verificações técnicas semanais nos portais (no ar, HTTPS, seções, arquivos legíveis por máquina) | Não feita. É a Fase 2. Os 139 endereços dos portais já vêm na base |
| **C. Autoavaliação guiada** | Checklist por critério, com pesos e o portão dos essenciais | **Protótipo pronto**: o simulador da ficha de cada município |

A camada A responde à pergunta "como está cada município". A B responde "como está **hoje**", entre um ciclo e outro. Nenhuma nota automática deve ser exibida como selo.

## 4. Dados abertos: o que existe (verificado)

| Fonte | O que dá | Acesso | Situação |
|---|---|---|---|
| **PNTP, dados abertos** | Por ente e ciclo: índice, nível, % essenciais, variação, link do portal. Respostas critério a critério, por UF | `pntp.atricon.org.br/dados-abertos/`; arquivos `.zip` com `.xlsx` (323 MB o de 2025) | **Verificado e usado.** Aviso da própria Atricon: o esquema muda entre ciclos (2022 tem 15 colunas, 2023 em diante 21) e a média só vale excluindo "Não Avaliado" |
| **Matriz 2026 e Cartilha 2026** | Critérios, classe, pesos, regras | `cdn.atricon.org.br` | **Verificado e usado** |
| **Siconfi (Tesouro)** | Cadastro de entes (população, CNPJ); relatórios fiscais (RREO, RGF, DCA) | API REST `apidatalake.tesouro.gov.br` | **Verificado** o cadastro (139 municípios do TO, com população e CNPJ). Os relatórios fiscais ficam para a Fase 2 e cruzam com os essenciais 11.5 e 11.6 |
| **TCE-TO** | "Portal do Cidadão (Transparência do Estado e Município)", módulo público do SICAP (licitações e obras), IEGM | `portaldocidadao.tceto.tc.br`, `app.tceto.tc.br/lo_publico` | Links vistos no site; conteúdo e formato **não avaliados**. Candidato a fonte da Fase 2 e a parceiro |
| PNCP | Contratações e contratos | API de consultas | Teste de conexão instável (a primeira tentativa falhou, a segunda respondeu); **não avaliado** |
| Querido Diário | Diários oficiais municipais | `queridodiario.org.br` responde; a API (`api.queridodiario.ok.org.br`) está **bloqueada** aqui | Cobertura do TO desconhecida |
| IBGE (API de localidades) | Municípios, microrregiões | `servicodados.ibge.gov.br` **bloqueado** aqui | Não necessário: a base do PNTP e o Siconfi já trazem o código IBGE |
| CGU, Escala Brasil Transparente | Nota de acesso à informação | Painel | Só municípios com mais de 50 mil habitantes (pouca cobertura no TO); não avaliado |

## 5. O que foi entregue: protótipo do módulo

Em [`modules/transparencia/`](../modules/transparencia/README.md). Sem dependências; roda com `python3 -m http.server`.

- **Panorama**: selos por ciclo, "mais perto do Diamante", "o que mais falha no estado" e o **aviso do ciclo 2026** (calculado a partir da matriz: critérios que viram essenciais e quem, com selo hoje, é atingido).
- **Prefeituras**: as 139, com busca, filtro por nível, ordenação e **download em CSV**.
- **Ficha do município**: placar com a marca de 95%, histórico, câmara e o **simulador** ("marque o que a prefeitura vai corrigir e veja índice e nível projetados", com o botão "caminho mais curto").
- **Critérios** e **Metodologia** (regras, essenciais, pesos, fontes, limites).

**Visual do mm.api.br.** A tela de login é pública e traz o CSS completo do site (v0.25). Dele tirei: três aparências (**Terminal** em âmbar sobre preto, **Claro** e **Escuro**, estas com `data-estilo="moderno"`), os componentes (`topbar`, `nav-item`, `kpi`, `tabela`, `chip`, `filtro`, `est-placar`, `est-serie`, `est-req`…) e a **política de segurança** (`script-src 'self'`, sem CDN, sem script inline). O módulo usa as mesmas classes e foi testado no Chromium sob essa política, nas três aparências e em celular, sem erros. O site já tem um "estudo do município" (`est-*`) e módulos em construção; o módulo foi feito para conviver com eles.

## 6. Plano de ação

### Fase 0: destravar (quase concluída)

Feito: visual do site obtido; base oficial baixada e analisada; regras e matriz 2026 lidas; Siconfi testado. **Falta**: ver as telas internas do `mm.api.br` (exige login) e a stack (framework e rotas), para encaixar o módulo como `/transparencia`; **liberar** `servicodados.ibge.gov.br`, `api.queridodiario.ok.org.br` e testar o PNCP; **contatar o TCE-TO e a ATM** (parceria e permissão para publicar).

### Fase 1: painel oficial (protótipo entregue)

Falta integrar ao site (layout, autenticação, rota), revisar com quem opera o PNTP no TCE-TO e **ingerir o ciclo 2026 quando sair (novembro)**: é rodar `build_dados.py` com os novos arquivos.

### Fase 2: sonda e cruzamentos (4 a 6 semanas)

- Sonda semanal nos 139 portais (no ar, HTTPS, seções, links para arquivos legíveis por máquina, impressão digital do fornecedor), com limite de taxa, `User-Agent` identificado e respeito a `robots.txt`.
- Cruzar os essenciais **11.5 e 11.6** (RGF e RREO) com a entrega no **Siconfi**, e as licitações com o PNCP e o SICAP.
- **Agrupar por fornecedor de portal**: um ajuste do fornecedor melhora vários municípios.

### Fase 3: autoavaliação guiada

O simulador vira o plano do município: critérios com responsável, prazo e evidência (URL, data, print), ordenados por ganho. O módulo é **preparação**: o lançamento oficial no Avalia é de servidor do controle interno, não de consultor.

### Fase 4: operação contínua

Alertas do calendário do ciclo, histórico, relatórios para TCE-TO, ATM e prefeituras, API aberta própria.

### Calendário

| Quando | O que |
|---|---|
| **Nov/2026** | Resultado do ciclo 2026 sai; ingerir e comparar com 2025 |
| Nov/2026 a jan/2027 | Integração da Fase 1 ao site |
| Fev a abr/2027 | Fase 2 pronta; a matriz do ciclo 2027 deve sair ~março |
| Abr a mai/2027 | Fase 3 pronta a tempo da autoavaliação 2027 (em 2026 foi de 20/04 a 29/05) |

## 7. Sugestões

1. **Comece pelo risco, não pelo ranking.** O estado já lidera; o maior valor é **não perder selo** (13 quedas em 2025) e proteger quem está com margem curta (29 Diamantes abaixo de 97%).
2. **Priorize as cidades grandes.** Araguaína (Prata) e Gurupi (Ouro) caíram de Diamante; Porto Nacional está sem selo. As três concentram população.
3. **Os essenciais são exigência legal, não só selo.** Para o gestor, "RGF e RREO no portal" pesa mais (transferências voluntárias e crédito) do que "Diamante". Use isso na comunicação.
4. **Alerta do 4.3 já.** Avisar Araguaína e Ponte Alta do Bom Jesus antes do resultado de novembro.
5. **Câmaras**: segunda frente, com tela própria (os dados já estão no módulo).
6. **Ficha de evidência datada** (URL, data, print): em 2026 o tribunal exige filtro estruturado; quem guarda a prova economiza tempo na validação e no recurso.
7. **Fornecedores de portal**: mapear quais concentram as falhas.
8. **Publicar o módulo como dado aberto** (CSV já sai; falta licença explícita), coerente com o tema.
9. **Teste real de SIC** (manual, opcional): a transparência passiva é o que robô nenhum mede.

## 8. Cuidados

- Uma nota automática pode ser lida como acusação: rotular como "indicador de apoio", com data, metodologia e canal de contestação.
- Nunca divulgar "perdeu/ganhou selo" a partir da sonda; só a partir do Radar.
- Coletar só o que é público, sem burlar bloqueios; sem dados pessoais além do que o portal já publica (LGPD).
- Citar a fonte e o ciclo em toda tela.

## 9. Limites, riscos e pendências

| Ponto | Situação |
|---|---|
| Simulador usa respostas de 2025 e fórmula 2026 | O resultado de 2026 pode diferir (matriz mudou: 96 critérios e 12 essenciais, contra 91 e 11) |
| Nível "Inexistente" de 2024 (20 prefeituras) | Pela Cartilha vem de portal inexistente ou fora do ar; **motivo não verificado caso a caso**. A variação para 2025 dessas fica exagerada |
| Esquema da base muda entre ciclos | O gerador valida o formato e falha se mudar; conferir colunas ao entrar o ciclo 2026 |
| `Ctrl+F` deixar de valer em 2026 | Só no material de treinamento do TCE-PI; a Cartilha trata do filtro de pesquisa, mas não cita o `Ctrl+F` |
| Telas internas do `mm.api.br` | **Não vistas** (login). O cartão sugerido para a home foi derivado das classes do CSS |
| Citações legais (LAI art. 8º §3º, LRF 48, 48-A e 51, Lei 14.133 art. 174) | LRF conferida na Cartilha; as demais, de memória: revisar com jurídico |
| Hosts ainda bloqueados | `servicodados.ibge.gov.br`, `api.queridodiario.ok.org.br`; PNCP instável; a ferramenta `WebFetch` não resolve DNS (usei `curl`) |

## 10. Fontes

Oficiais, lidas diretamente:

- PNTP: [pntp.atricon.org.br](https://pntp.atricon.org.br/) · [Dados abertos](https://pntp.atricon.org.br/dados-abertos/) · [Radar](https://radardatransparencia.atricon.org.br/)
- [Cartilha PNTP 2026](https://cdn.atricon.org.br/2026/08/Cartilha-PNTP-2026.pdf) · [Matriz de critérios 2026](https://cdn.atricon.org.br/2026/08/criterios_pntp_2026.zip)
- Bases: [ciclo 2025](https://cdn.atricon.org.br/2026/08/dados_pntp_2025.zip) · [2024](https://cdn.atricon.org.br/2026/08/dados_pntp_2024.zip) · [2023](https://cdn.atricon.org.br/2026/08/dados_pntp_2023.zip)
- Siconfi: [entes](https://apidatalake.tesouro.gov.br/ords/siconfi/tt/entes) · [APIs do Tesouro](https://www.gov.br/tesouronacional/pt-br/central-de-conteudo/apis)
- [TCE-TO](https://www.tceto.tc.br/) · tela de login do [mm.api.br](https://mm.api.br/login) (CSS)

Secundárias (só de apoio; o que importa foi confirmado acima): [Material de treinamento PNTP 2026 (TCE-PI)](https://www.tcepi.tc.br/wp-content/uploads/2026/04/PNTP-2026-TREINAMENTO.pdf) · [Cronograma Atricon 2026](https://atricon.org.br/wp-content/uploads/2026/02/Cronograma-PNTP-2026.pdf) · [PNCP: manual de consultas](https://www.gov.br/pncp/pt-br/acesso-a-informacao/manuais/ManualPNCPAPIConsultasVerso1.0.pdf) · [Qualidade dos dados do PNCP (Transparência Brasil)](https://transparencia.org.br/downloads/publicacoes/qualidade_dados_portal_nacional_de_contratacoes_publicas.pdf)
