# Estrutura-alvo do OmniSaúde e plano de melhorias

Este documento compara o OmniSaúde com os sistemas de gestão de saúde pública mais usados por prefeituras
(Celk Saúde, Inovadora G-MUS e SOUL MV) e com as exigências federais que esses sistemas atendem, e organiza o
que falta numa estrutura de módulos e em ondas de entrega. O que o OmniSaúde já tem está em
[`STATUS.md`](STATUS.md); a arquitetura, em [`ARQUITETURA.md`](ARQUITETURA.md).

## 1. O que foi analisado

| Fonte | O que foi lido | Observação |
|---|---|---|
| **Celk Saúde** (celk.com.br) | O site ficou fora do ar (erro 503) durante toda a análise. Foram usados a central de ajuda (manual com 683 páginas: 473 telas do Celk Saúde e 58 do Celk Hospital), as notas de versão de 2026 (uma por semana), a proposta comercial a Ilhota/SC (2023) e o guia do módulo de gestão da AMFRI (2016) | Concorrente mais completo: mais de 250 municípios, incluindo Florianópolis, Goiânia e Criciúma |
| **Inovadora** (inovadora.com.br) | Páginas de soluções: G-MUS (saúde municipal), G-HOSP (hospital), G-UPA, G-VIS (vigilância), G-END (endemias), Ivi (IA) | Produtos separados por equipamento de saúde; mais de 200 municípios |
| **MV** (mv.com.br) | O artigo indicado ("6 tecnologias...", de 2018, bem genérico: software, estações, biometria, tablets, nuvem, câmeras), mais as páginas do SOUL MV Saúde Pública e o artigo sobre regulação | Foco em rede estadual/municipal, sala de situação e regulação de leitos |
| **Exigências federais** | e-SUS APS (LEDI/Thrift), novo cofinanciamento da APS (Portaria GM/MS 3.493/2024, 15 indicadores de qualidade), RNDS como plataforma oficial do SUS (CPF como identificador), e-SUS Regulação substituindo o SISREG, Portaria GM/MS 6.656/2025 (envio de dados de regulação à RNDS) | Determinam o que um município **precisa** ter para receber repasses e prestar contas |

O que cada concorrente faz melhor, em uma linha:

- **Celk**: amplitude. Cobre todos os equipamentos (UBS, policlínica, CEO, CAPS, UPA, SAMU, hospital, vigilâncias, frota, consórcio) com os arquivos oficiais (e-SUS, BPA, APAC, AIH, RAAS, SINAN, SI-PNI/RNDS, Hórus/BNAFAR, SNCR). Em 2026 vem entregando assinatura digital, APIs públicas, indicadores do cofinanciamento, receitas no SNCR e integração SAMU–prontuário.
- **Inovadora**: prontuário certificado SBIS/CFM (NGS2), lista de espera e regulação, comunicação com o cidadão (lembretes, cancelamento, pesquisa de satisfação), vigilância sanitária muito completa (alvará digital, autos, livro de farmácia), endemias com roteirização e mapas de calor, e o chatbot **Ivi** (WhatsApp, agendamento, lembretes, triagem).
- **MV**: sala de situação e gestão à vista, regulação de leitos da rede inteira, auditoria de duplicidade de exames, app do ACS/ACE com sincronização sem internet, Imuniza MV, Portal/App do Cidadão.

E onde o OmniSaúde já está à frente dos três: IA aplicada ao atendimento (OCR de documentos, ditado para SOAP, copiloto de prescrição com interações, Text-to-SQL blindado), rastreabilidade de medicamentos GS1 do fornecedor ao leito (5 certos), trilha de auditoria com hash encadeado, acessibilidade em Libras e arquitetura multitenant com um banco por contratante (consórcios). Nenhum concorrente anuncia algo equivalente. Esses pontos devem ser preservados como diferencial enquanto a amplitude é construída.

## 2. Mapa de cobertura por domínio

Legenda: ✅ tem · 🟡 parcial · ⏳ não tem · — não encontrado nas fontes (pode existir).

| Domínio | Celk | Inovadora | MV | OmniSaúde hoje |
|---|---|---|---|---|
| Cadastro do cidadão (CADSUS, CPF, unificação de duplicados) | ✅ | ✅ | ✅ | 🟡 consulta CADSUS e duplicidade; sem unificação de cadastros nem domicílio/família |
| Cadastro de profissionais, unidades, equipes (CNES, INE, CBO) | ✅ | ✅ | ✅ | ⏳ só pela carga de demonstração; sem tela de cadastro nem importação do CNES |
| Recepção, senhas, painel de chamada, acolhimento | ✅ | ✅ | ✅ | ✅ |
| Classificação de risco (ACCR) | ✅ | ✅ | ✅ | ✅ |
| Prontuário (SOAP, CID/CIAP, prescrição, atestado) | ✅ | ✅ certificado SBIS/CFM | ✅ | ✅ com copiloto clínico; sem certificação |
| Assinatura digital ICP-Brasil | ✅ (2026) | ✅ | — | ⏳ |
| **e-SUS APS**: fichas CDS, envio ao PEC/SISAB (LEDI) | ✅ 46 telas | ✅ | ✅ | ⏳ |
| **Indicadores do cofinanciamento da APS** | ✅ menu próprio | ✅ painel | ✅ | ⏳ |
| ACS/ACE em campo (app offline, visitas, território, georreferência) | ✅ | ✅ | ✅ | ⏳ |
| Programas da APS (pré-natal, criança, HAS/DM, idoso, preventivo, Bolsa Família, SISVAN, tuberculose, MDDA) | ✅ | ✅ ações programáticas | ✅ | 🟡 linhas de cuidado por CID e busca ativa de crônicos |
| Saúde bucal (odontograma, CEO, indicadores eSB) | ✅ | ✅ | — | 🟡 odontograma; sem fluxo do CEO nem indicadores |
| Atividade coletiva, grupos, eMulti | ✅ | ✅ | — | ⏳ |
| Vacinas (sala de vacina, calendário, SI-PNI via RNDS, rede de frio) | ✅ | ✅ + temperatura | ✅ Imuniza | 🟡 registro de imunização enviado à RNDS; sem calendário, estoque de vacina ou rede de frio |
| Agenda, cotas, lista de espera, confirmação | ✅ | ✅ | ✅ | ✅ (confirmação por WhatsApp) |
| **Regulação** (solicitações, protocolos, prioridade, PPI/cotas, fila, agendamento regulado) | ✅ Acesso Regulador | ✅ | ✅ | ⏳ só o código de regulação na internação |
| TFD (laudo, processo, regional, viagem) | ✅ 24 telas | ✅ transportes | — | ⏳ |
| Transporte sanitário e frota (veículos, rotas, viagens) | ✅ | ✅ | — | ⏳ |
| Regulação de leitos / AIH (mapa de leitos da rede, médico regulador) | ✅ | 🟡 | ✅ | 🟡 leitos e NIR de um hospital; sem regulação da rede nem AIH |
| SAMU / urgência móvel | ✅ app + prontuário | — | — | ⏳ |
| UPA (observação, medicação, exames, transferência) | ✅ | ✅ G-UPA | ✅ | ✅ |
| Hospital (internação, centro cirúrgico, CCIH, nutrição, SAME, TISS) | ✅ Celk Hospital | ✅ G-HOSP | ✅ | 🟡 leitos, internação, alta, beira-leito |
| Assistência farmacêutica (estoque, dispensação, Portaria 344) | ✅ | ✅ | ✅ | ✅ com GS1 e NF-e |
| Hórus/BNAFAR, SNCR (receita controlada), judicialização de medicamentos | ✅ | ✅ regulação jurídica | — | ⏳ |
| Laboratório (LIS: coleta, bancada, laudo) e imagem (RIS/PACS) | ✅ | ✅ | — | ⏳ só solicitação de exames SIGTAP |
| Saúde mental / CAPS (RAAS, busca ativa) | ✅ | — | — | 🟡 RAAS citado; sem fluxo do CAPS |
| Vigilância epidemiológica (agravos, SINAN, georreferência) | ✅ | ✅ | — | ⏳ |
| Vigilância sanitária (alvará, inspeção, autos, livros) | ✅ | ✅ muito completa | — | ⏳ |
| Endemias e zoonoses (imóveis, ciclos, armadilhas, roteirização) | ✅ | ✅ G-END | ✅ app ACE | ⏳ |
| Faturamento: BPA | ✅ | ✅ | ✅ | ✅ |
| Faturamento: APAC, AIH, RAAS, PPI, pagamento a prestadores | ✅ | ✅ | ✅ | ⏳ |
| App/portal do cidadão (agenda, lembretes, exames, vacinas, medicamentos, TFD) | ✅ iOS/Android | ✅ | ✅ | ⏳ |
| Chatbot de IA para o cidadão (WhatsApp 24h) | — | ✅ Ivi | — | ⏳ (tem WhatsApp transacional) |
| Ouvidoria e pesquisa de satisfação | — | ✅ | ✅ | ⏳ |
| BI, sala de situação, gestão à vista, metas | ✅ | ✅ | ✅ | ✅ BI conversacional, produtividade, SLAs; sem sala de situação |
| Contratos de prestadores e auditoria de duplicidade | ✅ | — | ✅ | ⏳ |
| Consórcio intermunicipal (rateio, lançamentos) | ✅ | — | — | 🟡 tenant do tipo consórcio; sem rateio |
| Patrimônio, gastos, manutenção | ✅ | ✅ (hospital) | — | ⏳ |
| RNDS (RAC, imunização, dispensação, sumário de alta) | ✅ | — | ✅ | ✅ contra o simulador |
| Acessibilidade (Libras, painel com voz) | — | 🟡 painel com voz | — | ✅ |
| IA clínica (OCR, ditado, copiloto, Text-to-SQL) | — | — | — | ✅ |

## 3. Estrutura-alvo do sistema

A estrutura abaixo é o "mapa" para organizar o trabalho. Cada módulo tem um código para referência nas
tarefas. Os que já existem no OmniSaúde estão marcados.

```
OmniSaúde
├── NUC  Núcleo (cadastros oficiais)                 ├── REG  Regulação e acesso
│   ├── NUC-1 Cidadão: CADSUS/CPF, domicílio,        │   ├── REG-1 Solicitações e protocolos de encaminhamento
│   │         família, unificação de cadastros  🟡    │   ├── REG-2 Classificação de prioridade e fila única
│   ├── NUC-2 Estabelecimentos e CNES (importação)   │   ├── REG-3 PPI, cotas e contratos de prestadores
│   ├── NUC-3 Profissionais, equipes (INE), CBO,     │   ├── REG-4 Agendamento regulado e devolutivas
│   │         vínculos e lotações                    │   ├── REG-5 TFD (laudo, processo, viagem)
│   ├── NUC-4 Territórios, áreas, microáreas         │   ├── REG-6 Transporte sanitário e frota
│   ├── NUC-5 Tabelas: SIGTAP ✅, CID/CIAP ✅,        │   ├── REG-7 Regulação de leitos da rede e AIH
│   │         CATMAT ✅, calendário vacinal           │   ├── REG-8 Urgência móvel (SAMU)
│   └── NUC-6 Administração: unidades, usuários,     │   └── REG-9 e-SUS Regulação / RNDS (Portaria 6.656)
│             papéis ✅, licenças ✅                   │
│                                                    ├── HOS  Hospital
├── APS  Atenção Primária                            │   ├── HOS-1 Leitos, internação, alta, NIR ✅
│   ├── APS-1 Fichas e-SUS (CDS) e envio LEDI        │   ├── HOS-2 AIH e APAC
│   ├── APS-2 Indicadores do cofinanciamento (15)    │   ├── HOS-3 Centro cirúrgico
│   ├── APS-3 ACS em campo: app offline, visitas,    │   ├── HOS-4 CCIH, nutrição, SAME
│   │         cadastro domiciliar, georreferência    │   └── HOS-5 Convênios/TISS (hospitais mistos)
│   ├── APS-4 Programas: pré-natal, criança, HAS/DM, │
│   │         idoso, preventivo, Bolsa Família,      ├── FAR  Assistência farmacêutica
│   │         SISVAN, tuberculose/hanseníase, MDDA   │   ├── FAR-1 Estoque, NF-e, GS1, dispensação, 344 ✅
│   ├── APS-5 Estratificação de risco (gestante,     │   ├── FAR-2 Hórus / BNAFAR
│   │         pé diabético, M-CHAT, idoso)           │   ├── FAR-3 SNCR e receitas controladas digitais
│   ├── APS-6 Saúde bucal: CEO, indicadores eSB      │   ├── FAR-4 Judicialização e componente especializado
│   ├── APS-7 Atividade coletiva, grupos, eMulti     │   └── FAR-5 Rede de frio e temperatura
│   └── APS-8 Vacinas: sala, calendário, SI-PNI      │
│             via RNDS, estoque, faltosos            ├── VIG  Vigilância em saúde
│                                                    │   ├── VIG-1 Epidemiológica: agravos, SINAN, mapa
├── ATD  Atendimento (todos os níveis)               │   ├── VIG-2 Sanitária: alvará, inspeção, autos, livros
│   ├── ATD-1 Recepção, senhas, painel ✅             │   ├── VIG-3 Endemias: imóveis, ciclos, armadilhas, rotas
│   ├── ATD-2 ACCR ✅                                 │   └── VIG-4 Zoonoses (CVA)
│   ├── ATD-3 Prontuário SOAP + copiloto ✅           │
│   ├── ATD-4 Assinatura ICP-Brasil e certificação   ├── DIA  Apoio diagnóstico
│   │         SBIS/CFM                               │   ├── DIA-1 Laboratório (LIS): coleta, bancada, laudo
│   ├── ATD-5 UPA: observação, medicação ✅           │   └── DIA-2 Imagem (RIS) e integração PACS
│   ├── ATD-6 Saúde mental / CAPS (RAAS, PTS)        │
│   └── ATD-7 Telessaúde (teleconsulta,              ├── FAT  Faturamento e produção
│             teleinterconsulta)                     │   ├── FAT-1 SIGTAP, crítica, BPA ✅
│                                                    │   ├── FAT-2 APAC, AIH, RAAS
├── CID  Cidadão                                     │   ├── FAT-3 PPI e pagamento a prestadores
│   ├── CID-1 App/portal: agenda, lembretes,         │   └── FAT-4 Auditoria de duplicidade e glosas
│   │         exames, vacinas (certificado),         │
│   │         medicamentos, TFD, fila                ├── GES  Gestão e BI
│   ├── CID-2 Assistente de IA no WhatsApp (24h)     │   ├── GES-1 Produtividade, SLAs, pautas, BI ✅
│   ├── CID-3 Ouvidoria e pesquisa de satisfação     │   ├── GES-2 Sala de situação e gestão à vista
│   └── CID-4 Meu SUS Digital (dados via RNDS)       │   ├── GES-3 Consórcio: rateio e lançamentos
│                                                    │   └── GES-4 Patrimônio, gastos, manutenção
├── INT  Interoperabilidade (transversal)            │
│   ├── INT-1 RNDS ✅ (ampliar: regulação, vacinas)  └── PLT  Plataforma (transversal)
│   ├── INT-2 e-SUS APS (LEDI/Thrift e API do PEC)       ├── PLT-1 Multitenant, RBAC, auditoria hash ✅
│   ├── INT-3 CNES, CADSUS ✅, SIGTAP ✅                  ├── PLT-2 Mobile Android ✅ e modo offline
│   ├── INT-4 SINAN, SI-PNI, Hórus/BNAFAR, SNCR          ├── PLT-3 Georreferenciamento e mapas
│   ├── INT-5 e-SUS Regulação                            ├── PLT-4 LGPD: consentimento, expurgo, relatórios
│   └── INT-6 APIs públicas (estoque, agenda,            ├── PLT-5 Acessibilidade: Libras, voz ✅
│             vínculos) para outros sistemas             └── PLT-6 IA: OCR, ditado, copiloto, Text-to-SQL ✅
```

## 4. Ondas de entrega

A ordem segue três critérios: (1) o que impede um município de usar o sistema de verdade; (2) o que define
o repasse federal e a prestação de contas; (3) o que o cidadão e o gestor enxergam. Tamanho: P (dias),
M (semanas), G (meses), em esforço de uma pessoa.

### Onda 0: pré-requisitos para uso real

Sem isso, nenhuma secretaria consegue operar o OmniSaúde fora da demonstração.

| Código | Entrega | Tamanho | Depende de |
|---|---|---|---|
| NUC-6 | Telas de administração: unidades, profissionais, lotações (unidade + papel + CBO), usuários, redefinição de senha, 2FA obrigatório por papel | M | |
| NUC-2/3 | Importação do CNES: estabelecimentos pela API do DATASUS com conciliação (feito); profissionais e equipes INE por planilha (feito) e pelo arquivo "XML e-SUS AB" do CNES (pendente: depende de um exemplo do arquivo, cujo layout não é público) | M | NUC-6 |
| NUC-1 | Cadastro completo do cidadão (documentos, endereço com CEP, domicílio, família, responsável), unificação de cadastros duplicados, CPF como identificador | M | |
| ATD-4 | Assinatura ICP-Brasil (A1 no servidor; A3/nuvem pelo navegador) de prontuário, receita, atestado e documentos; validação | G | |
| FAT-1 | Validar o layout do BPA com o documento oficial do DATASUS e com uma competência real | P | |
| INT-1 | Credenciamento real na RNDS e validação dos perfis FHIR com o guia vigente | M | ATD-4 (certificado) |

### Onda 1: Atenção Primária e financiamento

É onde está a maior parte dos atendimentos de um município e o dinheiro do cofinanciamento federal.

| Código | Entrega | Tamanho | Depende de |
|---|---|---|---|
| APS-1 | Fichas do e-SUS (cadastro individual, domiciliar, atendimento individual, odontológico, procedimentos, atividade coletiva, visita domiciliar, vacinação, marcadores de consumo alimentar) geradas a partir do prontuário; exportação LEDI (Thrift/XML) e envio pela API do PEC; reprocessamento de glosas | G | NUC-1/2/3 |
| APS-2 | Painel dos 15 indicadores do cofinanciamento (Portaria 3.493/2024: acesso, criança, gestante/puérpera, diabetes, hipertensão, idoso, câncer da mulher; 6 de saúde bucal; 2 da eMulti), com fichas técnicas, lista nominal de pendências por equipe e projeção do repasse | M | APS-1 |
| APS-3 | App do ACS: cadastro domiciliar e individual, visitas, marcação no mapa, trabalho sem internet com sincronização; produtividade do agente | G | NUC-4, PLT-2 |
| APS-4 | Programas: pré-natal (DUM, DPP, consultas, exames, risco), puericultura (marcos, curvas), HAS/DM (metas, pé diabético, exames periódicos), idoso, preventivo e mamografia, Bolsa Família (condicionalidades), SISVAN, tuberculose/hanseníase, MDDA; cada um com lista de faltosos para a busca ativa | G | NUC-1 |
| APS-8 | Vacinas: calendário nacional por idade, sala de vacina, aprazamento e faltosos, estoque por lote e perda, envio ao SI-PNI via RNDS (RIA), certificado digital de vacinação | G | NUC-5, INT-1 |
| APS-6 | Saúde bucal: fluxo do CEO (encaminhamento, primeira consulta programada, tratamento concluído), indicadores eSB | M | APS-1 |
| APS-7 | Atividade coletiva e grupos (temas, público, participantes, procedimentos), ações da eMulti | M | APS-1 |

### Onda 2: Regulação e acesso

Fila única, transparente e integrada à RNDS. A Portaria 6.656/2025 exige o envio dos dados de regulação, e
o e-SUS Regulação está substituindo o SISREG (piloto em Campo Grande em 2026); a integração municipal
deve ser desenhada contra a documentação que o DATASUS publicar.

| Código | Entrega | Tamanho | Depende de |
|---|---|---|---|
| REG-1/2 | Solicitação de consulta, exame e procedimento a partir do atendimento, com protocolo de encaminhamento por especialidade, classificação de prioridade (com justificativa), anexos e fila única por procedimento; devolutiva ao solicitante | G | NUC-2 |
| REG-3 | PPI e cotas por prestador, unidade, profissional e CBO; contratos de prestadores (teto físico e financeiro) | M | REG-1 |
| REG-4 | Agendamento regulado (médico regulador autoriza, agenda, devolve ou nega), confirmação de presença, não comparecimento, remarcação; tempo médio de fila | M | REG-1/3 |
| REG-5 | TFD: laudo, processo, encaminhamento à regional, parecer, agendamento, viagem, acompanhante, ajuda de custo, impressão | M | REG-4 |
| REG-6 | Transporte sanitário: veículos, motoristas, rotas, viagens, roteiro do dia, manutenção e abastecimento | M | REG-5 |
| REG-7 | Regulação de leitos da rede: mapa de leitos de todos os hospitais, solicitação de vaga, avaliação do médico regulador (incluindo segunda avaliação), AIH, transferência | G | HOS-1, HOS-2 |
| REG-8 | SAMU: ocorrência, regulação médica, equipe/viatura, checklist diário, atendimento em campo (app) integrado ao prontuário | G | REG-7 |
| INT-5 | Interoperabilidade de regulação: envio à RNDS (6.656) e integração com o e-SUS Regulação | M | REG-4 |

### Onda 3: Cidadão

O que a população vê. É o diferencial mais visível politicamente e onde a IA do OmniSaúde se destaca.

| Código | Entrega | Tamanho | Depende de |
|---|---|---|---|
| CID-1 | App do cidadão (mesmo código web/Capacitor): login com CPF/gov.br, agendamentos e lembretes, cancelamento, resultados de exames, cartão de vacinas com certificado, medicamentos de uso contínuo e disponibilidade na farmácia, situação na fila e do TFD, unidades e horários | G | APS-8, REG-4, DIA-1 |
| CID-2 | Assistente no WhatsApp com IA (o que a Inovadora chama de Ivi): dúvidas sobre serviços, orientação para a unidade certa, agendamento e remarcação por conversa, resultados e vacinas, triagem de sintomas com encaminhamento, respeitando a janela de silêncio e a LGPD | M | CID-1, PLT-6 |
| CID-3 | Ouvidoria (manifestação, protocolo, prazo, resposta) e pesquisa de satisfação após o atendimento | M | |
| CID-4 | Compatibilidade com o Meu SUS Digital: os registros enviados à RNDS aparecem para o cidadão no app do Ministério | P | INT-1 |

### Onda 4: Vigilância em saúde

| Código | Entrega | Tamanho | Depende de |
|---|---|---|---|
| VIG-1 | Notificação de agravos a partir do atendimento (CID notificável), ficha de investigação por agravo no padrão SINAN, exportação, georreferenciamento dos casos, alertas de surto | G | ATD-3, PLT-3 |
| VIG-2 | Vigilância sanitária: cadastro de estabelecimentos e fatores de risco, alvará sanitário digital (solicitação, taxas, emissão, QR), roteiro de inspeção, autos de intimação e infração, denúncias, livros de farmácia e óptica | G | |
| VIG-3 | Endemias: imóveis, quarteirões, ciclos de visita, LIRAa, armadilhas e pontos estratégicos, app do agente com rota, mapa de calor | G | APS-3 (reaproveita o app) |
| VIG-4 | Zoonoses: animais, vacinação antirrábica, agressões, microchip | M | VIG-3 |

### Onda 5: Hospital e faturamento completo

| Código | Entrega | Tamanho | Depende de |
|---|---|---|---|
| HOS-2 / FAT-2 | AIH (laudo, autorização, lote, SISAIH01), APAC (laudo, autorização, produção), RAAS; conferência e espelho | G | NUC-2 |
| HOS-3 | Centro cirúrgico: agenda de salas, mapa cirúrgico, checklist de cirurgia segura, descrição, materiais | G | HOS-1 |
| HOS-4 | CCIH (infecções, culturas, antimicrobianos), nutrição (dietas, mapa), SAME (movimento de prontuário) | M | HOS-1 |
| FAT-3/4 | Pagamento a prestadores por produção, glosas, auditoria de duplicidade de exames e consultas | M | REG-3 |
| HOS-5 | TISS/convênios para hospitais mistos | G | opcional |

### Onda 6: Diagnóstico, farmácia estendida e gestão

| Código | Entrega | Tamanho | Depende de |
|---|---|---|---|
| DIA-1 | Laboratório: coleta com etiqueta, mapa de trabalho, bancada e interfaceamento de analisadores, laudo assinado, entrega ao cidadão | G | ATD-4 |
| DIA-2 | Imagem: agenda de exames, laudo, integração com PACS (DICOM) | G | ATD-4 |
| FAR-2 | Hórus/BNAFAR: envio de posição de estoque e dispensações | M | FAR-1 |
| FAR-3 | Receitas controladas digitais com integração ao SNCR | M | ATD-4 |
| FAR-4 | Judicialização (processos, medicamentos, prazos) e componente especializado (LME) | M | FAR-1 |
| FAR-5 | Rede de frio: temperatura e umidade de geladeiras e ambientes por sensor, alertas | M | APS-8 |
| GES-2 | Sala de situação: mapa da rede com filas, leitos, estoques críticos, surtos, indicadores em tempo real para a TV da secretaria | M | ondas 1 e 2 |
| GES-3 | Consórcio: rateio por município, lançamentos, relatórios de produção por ente | M | REG-3 |
| GES-4 | Patrimônio, gastos por unidade, manutenção predial e de equipamentos | M | |
| ATD-6 | CAPS: projeto terapêutico singular, acolhimento, busca ativa, RAAS | M | FAT-2 |
| ATD-7 | Telessaúde: teleconsulta e teleinterconsulta (reaproveita o canal de vídeo da Libras), com registro no prontuário | M | ATD-4 |

### Contínuo (em todas as ondas)

- **Certificação SBIS/CFM** do prontuário (NGS2): planejar desde a onda 0 os requisitos de segurança e trilha; é um argumento comercial dos concorrentes.
- **LGPD**: consentimento, relatório de acessos ao prontuário (já há a trilha), expurgo por tenant, encarregado.
- **Modo offline** (PLT-2) para UBS rurais: começa pelo app do ACS e se estende à recepção e à vacina.
- **APIs públicas** (INT-6) documentadas (OpenAPI) para que outros sistemas do município consultem estoque, agenda e vínculos, como a Celk passou a oferecer em 2026.
- **Acompanhar as versões** do LEDI (o Ministério deixa de aceitar versões antigas 12 meses após a nova) e do calendário vacinal.
- **Operação**: várias instâncias da API (adaptador Redis do Socket.IO), backup e restauração por tenant, monitoramento.

## 5. Sugestão de começo

1. **Onda 0 inteira** (NUC-6, NUC-2/3, NUC-1, ATD-4, FAT-1, INT-1): é o que transforma a demonstração num sistema implantável numa secretaria.
2. Em paralelo, **APS-1 e APS-2** (e-SUS e indicadores do cofinanciamento): é a primeira pergunta de qualquer secretário, porque define o repasse mensal.
3. Depois, **REG-1 a REG-5** (regulação e TFD): a maior dor de gestão citada pelos três fornecedores e exigida pela Portaria 6.656/2025.
4. **CID-1 e CID-2** logo em seguida: é onde o OmniSaúde pode superar os concorrentes com a IA que já tem.

Cada item acima pode virar uma tarefa própria com o código do módulo; o `STATUS.md` continua sendo o registro
do que foi concluído.

## Fontes consultadas

- Celk: [central de ajuda e manual](https://ajuda.celk.com.br/manual-do-usuario/celk-saude), [notas de versão 2026](https://ajuda.celk.com.br/release-notes/celk-saude/2026/celk-saude-3.1.346-or-29-10-2026), [proposta comercial a Ilhota/SC](https://ilhota.sc.gov.br/wp-content/uploads/2023/07/2520857_Proposta_Comercial__.pdf), [guia do módulo de gestão (AMFRI)](https://amfri.org.br/uploads/sites/567/2023/05/1018577_Anexo_8_%E2%80%93_Material_Didatico_%E2%80%93_Modulo_II.pdf), [Acesso Regulador](https://celk.com.br/complexo-regulador/), [app do cidadão em Braço do Norte](https://bracodonorte.sc.gov.br/noticia-524071/)
- Inovadora: [soluções](https://www.inovadora.com.br/solucoes/), [G-MUS](https://www.inovadora.com.br/solucoes/saude-municipal/), [G-HOSP](https://www.inovadora.com.br/solucoes/hospitais/), [G-UPA](https://www.inovadora.com.br/solucoes/upa/), [G-VIS](https://www.inovadora.com.br/solucoes/vigilancia-em-saude/), [G-END](https://www.inovadora.com.br/solucoes/gestao-de-endemias/), [Ivi](https://www.inovadora.com.br/solucoes/inteligencia-artificial/), [certificação SBIS/CFM do G-MUS](https://blog.inovadora.com.br/2022/10/o-g-mus-e-pela-sbis-cmf-nas-categorias.html)
- MV: [6 tecnologias para a gestão da saúde pública em rede](https://mv.com.br/blog/6-tecnologias-para-auxiliar-a-gestao-da-saude-publica-em-rede), [SOUL MV Saúde Pública](https://mv.com.br/solucao/soul-mv-saude-publica), [sistema de regulação na saúde pública](https://mv.com.br/blog/sistema-de-regulacao-na-saude-publica-como-organizar-o-atendimento-e-garantir-acesso-e-qualidade)
- Exigências federais: [integração e-SUS APS (LEDI)](https://integracao.esusab.ufsc.br/ledi), [API de transmissão LEDI do PEC](https://sisaps.saude.gov.br/sistemas/esusaps/docs/manual/APOIO/API_transmissao/), [perguntas frequentes do novo cofinanciamento da APS](https://www.gov.br/saude/pt-br/composicao/saps/esf/faq-novo-modelo-de-cofinanciamento-federal-da-aps), [15 indicadores de qualidade (SES/RS, maio/2025)](https://atencaoprimaria.rs.gov.br/indicadores-federal), [RNDS como plataforma oficial e CPF como identificador](https://www.cosemssp.org.br/noticias/ministerio-da-saude-oficializa-rnds-como-plataforma-do-sus-e-adota-cpf-como-identificador-nacional/), [Meu SUS Digital](https://www.gov.br/saude/pt-br/composicao/seidigi/meususdigital), [e-SUS Regulação](https://webatendimento.saude.gov.br/faq/esusregulacao), [migração do SISREG em Campo Grande](https://www.prefeituradecampogrande.org/campo-grande-inicia-migracao-do-sisreg-para-o-e/), [Portaria GM/MS 6.656/2025](https://p2saude.com.br/portaria-gm-ms-6-656-2025-novas-regras-para-envio-de-dados-de-regulacao-no-sus/)
