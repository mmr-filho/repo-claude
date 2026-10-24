# Módulo Transparência Municipal (Tocantins): plano de ação

Data da pesquisa: 24/10/2026. Escopo: critérios da Atricon (PNTP) para o Selo Diamante, como verificar os 139 municípios do Tocantins, o que existe de dados abertos e um plano em fases.

## 0. Leia primeiro: limites desta pesquisa

Este documento foi feito num ambiente **sem acesso direto à internet**: só a busca web funcionou. Não consegui abrir `atricon.org.br`, o Radar da Transparência, o TCE-TO, o IBGE, o Tesouro, o PNCP **nem o `mm.api.br`**. Consequências:

- Tudo abaixo vem de **resumos de busca** (notícias, ofícios e treinamentos de tribunais de contas), não da matriz oficial. Cada afirmação traz a **confiança**: **alta** (mais de uma fonte concordando), **média** (uma fonte plausível) ou **baixa/não verificado**.
- **Nenhum número do Tocantins por município foi obtido.** Não há aqui ranking nem lista de selos de prefeituras do TO. Isso é a primeira coisa a coletar (Fase 0).
- **O padrão visual do `mm.api.br` não foi visto.** Este repositório é o app de mensagens Sigilo (paleta verde de `apps/mobile/src/theme.ts`), que não tem relação com o site. Não inventei um visual. Veja a seção 8.
- Nenhum código foi escrito: não teria como testá-lo contra portais reais daqui.

## 1. O Selo Diamante e como a Atricon classifica

O PNTP (Programa Nacional de Transparência Pública) é coordenado pela Atricon com os tribunais de contas. Cada ente (prefeitura, câmara, poder) faz uma **autoavaliação** num questionário (sistema *Avalia*), o **tribunal de contas valida**, e a Atricon faz um **exame amostral**. O resultado vai para o **Radar da Transparência Pública** (endereço oficial: `radardatransparencia.atricon.org.br`; os domínios `.com` e `.inf.br` que aparecem na busca **não** são oficiais).

### Níveis (ciclo 2026)

| Nível | Índice | Itens essenciais |
|---|---|---|
| **Diamante** | 95% a 100% | 100% atendidos |
| Ouro | 85% a 94,9% | 100% |
| Prata | 75% a 84,9% | 100% |
| Elevado | 75% ou mais | menos de 100% |
| Intermediário | 50% a 74,9% | n/a |
| Básico | 30% a 49,9% | n/a |
| Inicial | 0,1% a 29,9% | n/a |
| Inexistente | 0% (inclui quem **não responde** o questionário) | n/a |

Confiança: **alta** para Diamante/Ouro/Prata; **média** para os demais (as fronteiras variam entre documentos: a Resolução Atricon 01/2022 e uma norma do TCE-SE diferem em 1 ponto nos níveis baixos). Tabela citada do ofício do TCE-PB para 2026. **Confirmar no regulamento oficial.**

**A regra que decide o Diamante:** não basta nota alta. Um único item **essencial** faltando derruba o selo (o ente cai para "Elevado", mesmo com 98%). Por isso o plano trata os essenciais como um *portão* separado da nota.

### Como a nota é composta

- Critérios classificados em **essenciais, obrigatórios e recomendados**, com **pesos 2, 1,5 e 1**. Confiança: **média** (uma fonte, baseada na Resolução 01/2023).
- Quantidade de critérios varia por fonte e tipo de ente: 124 (relato de 2024), 176 com 11 essenciais (6 na matriz comum + 4 do Executivo, segundo o Diagnóstico da Transparência), 181 em Santa Catarina em 2026 (72 comuns a todos). **Não usar nenhum desses números sem conferir a matriz 2026 do Executivo municipal.**
- A participação é obrigatória; quem não responde fica com 0%. Confiança: média.

### Novidades do ciclo 2026 (relevantes para o módulo)

Fonte: material de treinamento do TCE-PI. Confiança: **média**.

- O `Ctrl+F` deixa de valer como forma de busca: exige-se **filtro estruturado** nas dimensões de receita, despesa, diárias, convênios, licitações e contratos. Listas brutas em PDF/tabela corrida tendem a ser penalizadas.
- A **declaração de inexistência de informação** passa a atender alguns itens.
- O critério **4.3 (Despesa)** passou de obrigatório para **essencial**.
- A autoavaliação é **exclusiva de servidores** (vedado consultor/prestador no sistema) e exige cadastro na conta única da Atricon.

### Calendário

| Etapa | Ciclo 2026 | Observação |
|---|---|---|
| Matriz e cartilha | 20/03/2026 | |
| Autoavaliação | 20/04 a 29/05 | |
| Validação pelos tribunais | 01/06 a 10/08 | provisório (Atricon); TCE-SC usou 1 a 19/06 |
| Garantia da qualidade (Atricon) | 31/08 a 09/10 | amostral |
| Radar sendo preparado | 10/10 a 10/11 | |
| **Resultados** | **novembro/2026 (a confirmar)** | **estamos nessa janela** |

Consequência prática: o **ciclo 2025 (divulgado em dez/2025)** é o último resultado oficial; o **2026 sai em semanas**. O próximo ciclo (2027) deve abrir em torno de **março/abril de 2027**, o que dá ~4 a 5 meses para uma preparação com valor real.

### Panorama (ciclo 2025)

- 10.072 portais avaliados e 7.108 avaliações validadas; **2.912 certificados** (998 Diamante, 1.082 Ouro, 832 Prata). Outra fonte diz 2.911/997: diferença de 1, irrelevante. Segundo a Atricon, cerca de 50% das avaliações validadas tiveram **redução de nível**. Confiança: alta.
- **Tocantins:** TCE-TO conquistou o Diamante pelo 4º ano seguido e reportou 284 avaliações no ciclo 2025. Isso bate com 139 prefeituras + 139 câmaras + ~6 órgãos estaduais, o que sugere o universo avaliado (inferência minha). O portal do Governo do TO aparece com Diamante e 99,18% (subindo de 69,45% em 2024; confiança média). **Dianópolis** (prefeitura) recebeu Diamante (notícia de 25/02/2026, que a chama "4º ciclo": nomenclatura inconsistente entre fontes); a **Câmara de Sucupira** informa Ouro. **Não achei lista municipal completa.**

## 2. Como verificar a situação de cada município do TO

A resposta honesta é: **três camadas, que nunca devem ser misturadas na tela**.

| Camada | O que é | Valor | Limite |
|---|---|---|---|
| **A. Oficial** | Nível e índice do ente no Radar (ciclos 2023, 2024, 2025, 2026) | É a "verdade" que vale para o selo | Não confirmei se há exportação/API. Se não houver, a carga é manual/curada (139 entes por ciclo, viável) ou pedida ao TCE-TO |
| **B. Sonda automática** | Verificações técnicas que um robô consegue repetir toda semana | Cobertura total e atual, entre um ciclo e outro | **Não é a nota oficial.** Cobre só parte dos critérios |
| **C. Autoavaliação guiada** | Checklist por critério, com peso, evidência (URL e data) e status | Dá ao município o caminho até o Diamante | Depende de o município usar |

### O que a sonda (camada B) consegue e não consegue

Confiável, só HTTP: portal responde, HTTPS válido, tempo de resposta, presença de seções por palavra-chave (e-SIC, Ouvidoria, Licitações, Contratos, Diárias, Receitas, Despesas, Remuneração/Folha, LGPD/encarregado, Carta de Serviços, Dados Abertos), links para arquivos legíveis por máquina (`.csv`, `.xml`, `.json`, `.ods`), e "impressão digital" do fornecedor do portal.

Cruzamento com bases externas: entrega de RREO/RGF/DCA no Siconfi, contratações do município no PNCP, existência do diário oficial no Querido Diário.

**Só com pessoa (não automatizar e não prometer):** conteúdo atualizado e completo, funcionamento dos filtros estruturados (o ponto novo de 2026), **teste real de pedido de informação (SIC)**, acessibilidade completa (ferramentas automáticas pegam só uma parte), correção do conteúdo.

> Regra de produto: rotular sempre **"Oficial (Atricon, ciclo X)"**, **"Indicador de apoio (automático)"** e **"Autoavaliação do município"**. A sonda nunca exibe "Diamante/Ouro" por conta própria.

## 3. Dados abertos: o que existe

"Tem dados abertos?" tem três leituras; a resposta é diferente em cada uma.

1. **Os resultados do PNTP são dados abertos?** *Não confirmado.* O site do PNTP tem uma página "Dados abertos" (`pntp.atricon.org.br/dados-abertos/`), mas não vi o conteúdo; o Radar é um painel. **Primeira ação da Fase 0.**
2. **Há dados abertos para alimentar o módulo?** *Sim, vários* (tabela abaixo).
3. **Cada município publica dados abertos?** *A medir* na sonda (é também tema da LAI, art. 8º, §3º, que exige formatos abertos e acesso automatizado; citado de memória, validar com jurídico).

| Fonte | O que dá | Acesso | Confiança / ressalva |
|---|---|---|---|
| Radar / PNTP (Atricon) | Nível e índice por ente | Painel; exportação a confirmar | Média. Pedir a base ao TCE-TO se não houver |
| IBGE (localidades) | 139 municípios, códigos (UF 17), microrregião, população | API pública | Não testada aqui; endpoint de memória, validar |
| Siconfi (Tesouro) | RREO, RGF, DCA, MSC por ente | API REST (`apidatalake.tesouro.gov.br`) | Alta quanto à existência; endpoints a testar |
| PNCP | Contratações, contratos e atas por órgão | API de consultas (manual oficial) | Há problemas de qualidade (Transparência Brasil, dez/2024) e relato de terceiro (04/10/2026) de filtros ignorados sem aviso. **Validar cada filtro** antes de confiar |
| Querido Diário (OKBR) | Diários oficiais municipais, busca e API | API aberta | Cobertura do TO atual **desconhecida** (só Palmas em matéria de 2021) |
| CGU, Escala Brasil Transparente 360 | Nota de acesso à informação | Painel | Só municípios com mais de 50 mil hab.: pouca cobertura no TO |
| Transparência Internacional (ITGP) | Índice estadual (TO em 21º, 57,5/100 em 2025) | Publicação | Estadual, não municipal. Útil só como contexto |
| TCE-TO | Possíveis dados de fiscalização/portais | Desconhecido | **Perguntar diretamente.** Parceiro natural |

## 4. Plano de ação em fases

Estimativas assumem 1 a 2 pessoas de desenvolvimento e acesso à internet aberta. Nenhuma dura mais que o necessário para validar a anterior.

### Fase 0: destravar (1 a 2 semanas, **antes de qualquer tela**)

1. Obter acesso ao padrão visual do `mm.api.br` (seção 8) e definir **em qual repositório** o módulo nasce.
2. Baixar a **matriz oficial 2026 do Executivo municipal** e a cartilha; transformar em tabela (código do critério, dimensão, classe essencial/obrigatório/recomendado, peso, item de verificação, "automatizável?").
3. Abrir o Radar e a página "Dados abertos" do PNTP; verificar se há exportação. Registrar o resultado.
4. Contato com o **TCE-TO** (base do ciclo, ofícios) e a **ATM** (associação dos municípios): parceria e permissão para publicar.
5. Rodar uma chamada de teste em cada API (IBGE, Siconfi, PNCP, Querido Diário) e anotar o que falha.

**Entrega:** matriz em planilha, inventário de fontes verificado, decisão de arquitetura.

### Fase 1: painel oficial, MVP (3 a 4 semanas)

- Cadastro dos 139 municípios (IBGE) e série **2023–2026** de nível/índice (carga curada ou pela base do TCE-TO).
- Telas: **ranking do TO**, **ficha do município** (histórico, se perdeu/ganhou nível), **mapa** por nível, filtro por microrregião/porte.
- Indicador **"distância até o Diamante"** (quantos pontos faltam) e lista de "quase lá" (Ouro alto).
- Exportação CSV/JSON dos próprios dados.

**Valor imediato** e baixo risco: só reorganiza dados oficiais.

### Fase 2: sonda e dados abertos (4 a 6 semanas)

- Descobrir o portal de cada município (cadastro + validação manual das 139 URLs).
- Sonda semanal (seção 2), com *rate limit*, `User-Agent` identificado e respeito a `robots.txt`.
- Cruzamentos Siconfi/PNCP/Querido Diário por código IBGE e CNPJ.
- **Agrupar por fornecedor de portal**: se um fornecedor atende vários municípios, um ajuste dele melhora vários de uma vez. É a alavanca mais barata do estado.
- Tela "indicadores de apoio", sempre separada do oficial.

### Fase 3: autoavaliação guiada (4 a 6 semanas)

- Checklist da matriz com **pesos**, evidência (URL + data + print) e responsável.
- **Simulador**: marca os itens, mostra a nota projetada **e o portão dos essenciais** ("faltam 2 essenciais; sem eles o máximo é Elevado").
- **Plano de ação do município** gerado do que falta, ordenado por (peso × facilidade), com prazo ancorado no calendário do ciclo 2027.
- Perfis: servidor do controle interno (único que pode lançar no Avalia oficial, então o módulo é **preparação**, não substitui o Avalia).

### Fase 4: operação contínua

- Alertas de calendário (abertura do ciclo, prazo de autoavaliação, recursos).
- Histórico, relatórios para TCE-TO/ATM/prefeituras, comparativo regional.
- API aberta própria, com licença explícita (ex.: CC-BY).

### Linha do tempo sugerida

| Quando | O que |
|---|---|
| Nov/2026 | Fase 0; **ingerir o resultado 2026 assim que sair** |
| Dez/2026 a jan/2027 | Fase 1 no ar |
| Fev a abr/2027 | Fase 2; matriz 2027 sai (~mar) e a sonda já está calibrada |
| Abr a mai/2027 | Fase 3 pronta a tempo da autoavaliação 2027, o momento de maior uso |

## 5. Sugestões

1. **Priorize os essenciais.** Um município com 94% e todos os essenciais está mais perto do Diamante do que um com 97% e um essencial faltando. A interface deve mostrar o portão primeiro.
2. **Foco nos "quase lá"**: municípios em Ouro/Prata alto rendem mais selos por hora de trabalho do que os de nível Básico.
3. **Alavanca por fornecedor** (Fase 2): mapa de quais fornecedores concentram as falhas.
4. **Ficha de evidência datada** (URL, data, print): em 2026 o tribunal pede filtro estruturado, e quem guarda a prova economiza tempo na validação e no recurso.
5. **Kit "portal mínimo"** para municípios pequenos: modelo de estrutura e textos (SIC, LGPD, ouvidoria, carta de serviços).
6. **Publicar o próprio módulo como dado aberto**: coerente com o tema e facilita parcerias (imprensa, universidades, MP).
7. **Parceiros**: TCE-TO, ATM, CGE-TO, MPTO, universidades.
8. **Teste de SIC cidadão** (opcional e manual): pedidos reais padronizados, com consentimento e protocolo, para medir a transparência passiva, que robô nenhum mede.

## 6. Cuidados éticos e legais

- Uma nota automática pode ser lida como acusação. Rotular como "indicador de apoio", com data, metodologia e **canal de contestação** para o município.
- Nunca divulgar "perdeu/ganhou selo" a partir da sonda; só a partir do Radar.
- Coletar só o que é público, sem burlar bloqueios; sem dados pessoais de servidores além do que o portal já publica (LGPD).
- Citar a fonte oficial e o ciclo em toda tela. Não usar os domínios não oficiais do Radar como fonte.

## 7. Riscos e pontos a confirmar

| Risco / dúvida | Como tratar |
|---|---|
| Radar sem exportação e com termos que vedam coleta | Pedir a base ao TCE-TO / Atricon; fallback: carga manual curada |
| Matriz muda a cada ciclo | Guardar a matriz como dado versionado, não como código |
| Números de critérios divergem entre fontes | Usar só a matriz oficial do ciclo e do tipo de ente |
| APIs com qualidade irregular (PNCP) | Tratar como indício, não prova; sempre validar |
| Portais fora do ar, bloqueio por WAF | Sonda com *retry*, janela larga e registro de falha (falha ≠ "sem transparência") |
| Datas do ciclo 2026 eram provisórias | Reconfirmar no calendário do TCE-TO |
| Citações legais de memória (LAI art. 8º, §3º; LRF arts. 48 e 48-A; Lei 14.133 art. 174) | Revisar com jurídico antes de publicar |

## 8. Padrão visual do `mm.api.br`: o que preciso

Não consegui acessar o site e o único repositório visível aqui não é o dele. Para o módulo ficar com a mesma cara, qualquer um destes serve (do melhor para o mais simples):

1. O **repositório** do `mm.api.br` (se estiver no GitHub, dá para anexá-lo à sessão).
2. O arquivo de **tokens/CSS** (cores, fontes, espaçamentos, raios, sombras) e a lista de componentes.
3. **Capturas de tela** das páginas principais, em modo claro e escuro, se o site tiver os dois.

Também preciso saber a **stack** do site (framework, e como as rotas/API são organizadas) para o módulo entrar como `/transparencia` sem retrabalho.

## 9. Fontes consultadas (todas via busca; nenhuma aberta diretamente)

- PNTP: [pntp.atricon.org.br](https://pntp.atricon.org.br/) · [Dados abertos](https://pntp.atricon.org.br/dados-abertos/) · [Atricon: validação 2025](https://atricon.org.br/pntp-2025-conclui-etapa-de-validacao-pelos-tcs/)
- Ciclo 2026: [Cronograma Atricon](https://atricon.org.br/wp-content/uploads/2026/02/Cronograma-PNTP-2026.pdf) · [Metodologia (TCE-PI)](https://www.tcepi.tc.br/wp-content/uploads/2026/04/Metodologia-PNTP-2026.pdf) · [Treinamento (TCE-PI)](https://www.tcepi.tc.br/wp-content/uploads/2026/04/PNTP-2026-TREINAMENTO.pdf) · [Cronograma TCE-SC](https://www.tcesc.tc.br/sites/default/files/2026-03/PNTP_Ciclo_2026_Cronograma.pdf) · [Ofício TCE-PB (níveis)](https://tce.pb.gov.br/wp-content/uploads/2026/04/1-Oficio-PNTP-CICLO-2026.pdf)
- Matriz e pesos: [Diagnóstico da Transparência](https://diagnostico.transparencia.com.br/entenda-a-matriz-de-avaliacao-da-transparencia-desenvolvida-pela-atricon/) · [Resolução Atricon 01/2022](https://atricon.org.br/wp-content/uploads/2022/07/Resolucao-01_2022-Altera-Resolucao-Atricon-09-2018-2.pdf) · [FAQ TCE-MG](https://www.tce.mg.gov.br/fale_tce/docs/PNTP-PerguntasFrequentesTCEMG_2025.pdf)
- Resultados 2025: [TCE-RN](https://www.tce.rn.gov.br/Noticias/NoticiaDetalhada/7748) · [TCE-SP](https://tce.sp.gov.br/6524-tcesp-entrega-selos-programa-nacional-transparencia-publica)
- Tocantins: [TCE-TO Diamante](https://www.tceto.tc.br/tceto-conquista-selo-diamante-de-transparencia-publica-pelo-quarto-ano-consecutivo/) · [Portal do Governo do TO](https://www.agenciatocantins.com.br/noticia/103276/portal-da-transparencia-do-tocantins-e-reconhecido-como-um-dos-cinco-melhores-do-brasil) · [Dianópolis](https://www.conexaoto.com.br/2026/02/25/prefeitura-de-dianopolis-conquista-selo-diamante-de-transparencia-publica) · [Câmara de Sucupira](https://sucupira.to.leg.br/gestao-transparente/) · [ITGP Tocantins](https://transparenciainternacional.org.br/itgp/governo-estadual/tocantins)
- Dados abertos: [APIs do Tesouro](https://www.gov.br/tesouronacional/pt-br/central-de-conteudo/apis) · [Manual PNCP (consultas)](https://www.gov.br/pncp/pt-br/acesso-a-informacao/manuais/ManualPNCPAPIConsultasVerso1.0.pdf) · [Qualidade dos dados do PNCP](https://transparencia.org.br/downloads/publicacoes/qualidade_dados_portal_nacional_de_contratacoes_publicas.pdf) · [Filtros do PNCP (relato de terceiro)](https://www.tabnews.com.br/dmanoel/a-api-do-pncp-ignora-filtros-em-silencio-o-que-aprendi-montando-um-servidor-mcp-de-licitacoes) · [Querido Diário](https://docs.queridodiario.ok.org.br/en/latest/what-is-it.html) · [Escala Brasil Transparente](https://brasil61.com/noticias/escala-brasil-transparente-avalia-cumprimento-da-lei-de-acesso-a-informacao-entre-estados-e-municipios-bras214401)
