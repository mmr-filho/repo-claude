# Módulo Transparência Municipal (Tocantins): pesquisa e plano de ação

Atualizado em 24/10/2026, depois de liberada parte da rede. A primeira versão deste documento (só com resumos de busca) foi substituída: agora os números vêm da **base aberta do PNTP**, da **Cartilha PNTP 2026** (299 páginas) e da **matriz de critérios 2026**, todas baixadas e lidas.

**Objetivo do módulo:** olhar **uma prefeitura de cada vez**, com um panorama para o prefeito e um **plano de ação** até os critérios do selo. Os números do estado (seção 2) ficam só como contexto.

O protótipo, com dados reais, está em [`modules/transparencia/`](../modules/transparencia/README.md).

## 0. Em resumo

1. **Para cada prefeitura dá para montar o plano de ação com dado oficial.** A Atricon publica, em dados abertos, as respostas critério a critério validadas pelo TCE-TO, com a **observação do avaliador**, o **link da página conferida** e o **print**. Juntando isso com a **matriz e a Cartilha 2026**, cada pendência vira uma ação: o que falta, por que o tribunal recusou, o que a Cartilha exige, quanto o índice sobe e qual setor cuida.
2. **A nota é reproduzível.** A fórmula da Cartilha, aplicada às respostas de 2025, reproduz o índice oficial com erro médio de **0,01 ponto** (138 de 139 prefeituras idênticas). O plano usa a mesma fórmula com os pesos de 2026.
3. **A numeração dos critérios muda entre ciclos** (por exemplo, a lista de estagiários era o 6.3 em 2025 e é o 6.4 em 2026). Por isso as respostas de 2025 são ligadas à matriz 2026 pelo texto do critério, não pelo número.
4. **O que 2026 muda para as prefeituras.** O 4.3 (consulta de empenhos) vira essencial: Araguaína e Ponte Alta do Bom Jesus têm selo e não o atendem. E entram 3 critérios novos (conselhos do Fundeb, de Saúde e de Assistência Social): **23 prefeituras Diamante ficam abaixo de 95% na estimativa só por causa deles**. Para essas, publicar os dados dos conselhos é o que separa manter de perder o Diamante.
5. **Contexto do estado.** O Tocantins é o 2º do país (78 das 139 prefeituras Diamante em 2025). Em mediana, cada prefeitura tem 10 critérios pendentes ou a conferir.
6. **O visual do `mm.api.br`** (tela de login pública, com o CSS do site) é reutilizado pelo protótipo. Falta ver as telas internas, que exigem login.

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
- **Numeração e conteúdo mudaram** (comparação da matriz 2026 com as respostas de 2025): o 6.2 de 2025 (remuneração e tabela de cargos) virou 6.2 e 6.3; os antigos 6.3 a 6.6 passaram a 6.4 a 6.7; o 17.1 (emendas) virou 17.1 (federais) e 17.2 (estaduais e municipais), e o antigo 17.2 (emendas Pix) virou 17.3, mais amplo. **16.1 e 16.2** (renúncia de receita) passam de recomendados a obrigatórios, assim como as emendas (17.x). **Novos:** 18.6 (Conselho de Saúde), 19.3 (Conselho do Fundeb) e 19.4 (Conselho de Assistência Social).
- **Não há atendimento parcial**: o critério só conta como atendido quando todas as informações exigidas na disponibilidade estão no portal (Cartilha). É por isso que o plano trabalha por critério.
- A página do PNTP informa que o ciclo 2026 está na etapa de treinamento da garantia da qualidade e que **os resultados serão divulgados em novembro, no Rio de Janeiro**. O ciclo 2025 foi divulgado em dezembro de 2025.

## 2. Contexto: onde o Tocantins está

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
| **C. Plano de ação do município** | Cada critério pendente vira uma ação, com observação do tribunal, orientação da Cartilha, ganho e setor | **Protótipo pronto**: panorama, plano, checklist e relatório de cada prefeitura |

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

Em [`modules/transparencia/`](../modules/transparencia/README.md). Sem dependências; roda com `python3 -m http.server`. Tudo gira em torno de **uma prefeitura**:

- **Escolha do município** (busca; lembra o último).
- **Panorama para o prefeito**: resultado oficial, um parágrafo com o diagnóstico em linguagem simples, estimativa nas regras de 2026, placar com as faixas de Prata, Ouro e Diamante, **alerta dos essenciais** (com a consequência da LRF), o que muda em 2026 para essa prefeitura, **onde ela perde pontos** por dimensão, histórico, próximos passos do calendário e a câmara.
- **Plano de ação**: meta (Diamante, Ouro ou Prata) e etapas: essenciais; o menor caminho até a meta; critérios novos a conferir; demais pendências. Cada ação traz o que falta (por item de verificação), a **observação do tribunal**, o link da página avaliada e do print, a **página da Cartilha** e o texto do que ela exige, o ganho em pontos e o setor sugerido. Dá para agrupar **por setor** (para distribuir tarefas), marcar ações como concluídas e ver a projeção, e baixar em CSV.
- **Checklist**: os 96 critérios de 2026 com a situação de cada um (atende, pendente, a conferir).
- **Relatório para imprimir** (ou salvar em PDF): diagnóstico e plano numa página para o gabinete.
- **Metodologia**: regras, essenciais, cálculo, como o plano é montado e limites.

**Visual do mm.api.br.** A tela de login é pública e traz o CSS completo do site (v0.25). Dele vêm as três aparências (**Terminal** em âmbar sobre preto, **Claro** e **Escuro**, estas com `data-estilo="moderno"`), os componentes (`topbar`, `nav-item`, `kpi`, `tabela`, `chip`, `filtro`, `est-placar`, `est-serie`, `est-req`…) e a **política de segurança** (`script-src 'self'`, sem CDN, sem script inline). O módulo usa as mesmas classes e foi testado no Chromium sob essa política, nas três aparências, em celular e em modo de impressão, sem erros.

## 6. Plano de ação

Situação em 24/10/2026, depois da execução do que dependia só deste trabalho.

| Fase | Situação |
|---|---|
| 0. Destravar | **Parcial.** Feito: visual do site, base oficial, Cartilha e matriz 2026, Siconfi. Pendente (depende de você ou de terceiros): telas internas e stack do `mm.api.br`; contato com o TCE-TO e a ATM |
| 1. Panorama e plano por prefeitura | **Protótipo pronto.** Pendente: integrar ao site; revisar o texto com uma ou duas prefeituras; atualizar com a base do ciclo 2026 (ainda não publicada em 24/10) |
| 2. Verificações | **Executada**, com dois ajustes de escopo (abaixo) |
| 3. Acompanhamento do plano | **Executada no protótipo.** Pendente: o endpoint no servidor do site (contrato pronto) |
| 4. Operação contínua | Agenda das verificações definida (README); alertas e API aberta própria ficam para depois da integração |

### Fase 2: verificações (executada)

- **Siconfi (Tesouro): entregas de RREO e RGF** de cada prefeitura em 2025 e 2026, ligadas aos essenciais 11.5 e 11.6 (`tools/coleta_siconfi.py`). Aparece no panorama e no cartão da ação: "o último RGF entregue ao Tesouro é o do 1º quadrimestre de 2026; o mesmo relatório precisa estar no portal". Em 24/10/2026, 135 das 139 prefeituras tinham os 6 bimestres de RREO de 2025, e 103 já tinham o 4º bimestre de 2026. **Araguanã e Muricilândia** não têm RREO nem RGF registrados em 2025 e 2026 (conferido nos dados brutos); o painel sugere conferir com a contabilidade. *Cuidado tomado:* os municípios menores entregam versões "simplificadas" (RGF semestral); a primeira coleta as ignorava e teria acusado 69 prefeituras sem RREO.
- **Sonda das capas dos 139 portais** (`tools/sonda.py`): uma visita por portal, identificada, respeitando o `robots.txt`. Em 24/10/2026: 135 responderam, todas com HTTPS; **Combinado** respondeu "página não encontrada" (404) no endereço registrado na avaliação; um servidor recusou a verificação (403); dois não responderam daqui (não é prova de site fora do ar). Comparada com a avaliação validada de 2025, a sonda acerta quando **encontra**: 98% para o link da transparência (1.3) e 97% para o botão do Radar (2.9). Quando não encontra, o tribunal aceitou mesmo assim em 100% e 92% dos casos; por isso "não encontrado" não é tratado como falha.
- **Ajustes de escopo:** o **agrupamento por fornecedor** não é viável com o que é público: 133 das 139 prefeituras publicam a transparência no próprio domínio `.to.gov.br`, e as capas não trazem assinatura do fornecedor. O **PNCP** não respondeu no endereço de consulta testado; fica para quando houver necessidade (licitações não são essenciais).

### Fase 3: acompanhamento do plano (executada no protótipo)

Cada ação tem situação (pendente, em andamento, concluída), responsável, prazo (vencido aparece como "Atrasada") e link de evidência; a projeção do índice conta só o concluído. Sem servidor, fica no navegador e é **exportado e importado** em arquivo (a equipe compartilha por e-mail ou pasta); com `data-api`, grava na API do site. O contrato (GET e PUT por prefeitura) está no README do módulo. O teste de ponta a ponta (`npm run test:transparencia`) cobre as duas formas. O módulo continua sendo **preparação**: o lançamento oficial no Avalia é de servidor do controle interno.

### O que falta e depende de você

1. **Integração ao `mm.api.br`**: acesso ao código ou à stack, para criar a rota `/transparencia` e o endpoint do acompanhamento (com o controle de quem edita cada prefeitura).
2. **Agendar as verificações** no servidor do site (linhas de cron no README).
3. **Base do ciclo 2026**: quando a Atricon publicar (o resultado sai em novembro), rodar `build_dados.py` com os novos arquivos e revisar a tabela de ligação entre ciclos que ele imprime.
4. **Conversas**: TCE-TO e ATM (parceria e permissão para publicar) e uma ou duas prefeituras-piloto para revisar o texto.

### Calendário

| Quando | O que |
|---|---|
| **Nov/2026** | Resultado do ciclo 2026 sai; ingerir e comparar com 2025 |
| Nov/2026 a jan/2027 | Integração ao site (rota e endpoint do acompanhamento); atualizar com a base do ciclo 2026 quando publicada |
| Fev a abr/2027 | Prefeituras executam o plano; verificações semanais (sonda) e mensais (Siconfi); a matriz do ciclo 2027 deve sair ~março |
| Abr a mai/2027 | Autoavaliação 2027 (em 2026 foi de 20/04 a 29/05): o acompanhamento serve de lista de evidências |

## 7. Sugestões

Para a prefeitura (o que o plano já organiza):

1. **Essenciais primeiro.** Além do selo, a LRF (arts. 48, 48-A e 51) restringe transferências voluntárias e operações de crédito de quem não divulga essas informações. É o argumento que mais pesa para o prefeito.
2. **Ler a observação do tribunal.** Muitas recusas são concretas e baratas de resolver ("os relatórios não abrem", "não informa o procedimento licitatório"). Elas valem como lista de tarefas.
3. **Conferir os critérios novos já.** Os conselhos do Fundeb, de Saúde e de Assistência Social costumam já existir; falta publicar. Para 23 prefeituras Diamante, é o que garante a faixa de 95%.
4. **Distribuir por setor.** O agrupamento por setor transforma o plano em pauta de reunião com cada secretaria.
5. **Falar com o fornecedor do portal.** Parte das falhas (filtro, exportação em planilha, série histórica, relatórios que não abrem) é da plataforma, não do conteúdo.
6. **Guardar evidência datada** (URL, data, print) de cada item corrigido: agiliza a autoavaliação e eventual recurso.
7. **Margem de segurança.** A validação e a revisão costumam derrubar itens; mirar acima de 95%.

Para o módulo:

8. **Câmaras municipais**: mesma visão para o Legislativo (os dados já estão na base).
9. **Publicar os dados do módulo** com licença explícita, coerente com o tema.

## 8. Cuidados

- Uma nota automática pode ser lida como acusação: rotular como "indicador de apoio", com data, metodologia e canal de contestação.
- Nunca divulgar "perdeu/ganhou selo" a partir da sonda; só a partir do Radar.
- Coletar só o que é público, sem burlar bloqueios; sem dados pessoais além do que o portal já publica (LGPD).
- Citar a fonte e o ciclo em toda tela.

## 9. Limites, riscos e pendências

| Ponto | Situação |
|---|---|
| Plano usa respostas de 2025 com as regras de 2026 | É uma estimativa conservadora: o que não foi avaliado em 2025 conta como pendente. A matriz do ciclo 2027 pode mudar de novo |
| Ligação entre ciclos pelo texto | Revisada critério a critério para 2025 → 2026 (o gerador imprime a tabela); refazer a revisão a cada nova matriz |
| Setor responsável | Sugestão por dimensão; cada prefeitura tem sua estrutura |
| Verificações automáticas | São pistas, não avaliação. A sonda lê só a capa, e uma falha de conexão pode ser da rede de quem verifica (por isso deve rodar do servidor do site). O Siconfi mostra a entrega ao Tesouro, não o que está publicado no portal |
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
