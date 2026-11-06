# Cronograma de trabalho

Plano de execução do [`ROADMAP.md`](ROADMAP.md), em semanas, a partir de **3 de novembro de 2026**. Cada
semana tem entregas com critério de pronto e o que precisa vir de fora (credenciais, decisões, documentos).
O andamento é registrado no [`STATUS.md`](STATUS.md) e cada entrega vai para o ar em
https://mm.api.br/omnisaude assim que passa nos testes.

Regras de trabalho:

- Toda entrega sobe com testes automatizados e com a tela verificada no navegador.
- Nada bloqueia o resto: se um item depende de algo externo (certificado, credencial da RNDS), ele fica
  pronto contra um simulador e é validado quando o insumo chegar.
- Cada semana termina com a demonstração atualizada e o `STATUS.md` revisado.

## Fase 1 (semanas 1 a 5): onda 0, uso real

| Semana | Código | Entrega | Pronto quando | Precisa de você |
|---|---|---|---|---|
| 1 (3 a 7/11) ✅ entregue em 30/10 | NUC-6 | Área **Administração** no sistema: unidades (cadastro, tipo, CNES, horário), profissionais (CPF, nome, CNS, conselho/registro, CBO, e-mail, telefone), lotações (unidade + papel + CBO), ativar/desativar, redefinição de senha com senha provisória, 2FA obrigatório por papel, usuários de plataforma | O gestor cadastra uma unidade e um profissional novos pela tela e esse profissional entra no sistema sem a carga de demonstração | Decidir quais papéis exigem 2FA (sugestão: gestão, faturamento, farmácia e médico) |
| 2 (10 a 14/11) 🟡 entregue em 30/10, sem o XML | NUC-2/3 | **Importação do CNES**: estabelecimentos, profissionais, vínculos e equipes (INE) a partir do arquivo mensal do CNES ou da API do DATASUS, com conciliação (o que é novo, o que mudou, o que sumiu) e revisão antes de aplicar | Importar o CNES de um município real cria as unidades e os profissionais corretos, sem duplicar os existentes | Código IBGE do município de teste; se houver, o arquivo do CNES baixado do portal |
| 3 (17 a 21/11) ✅ entregue em 30/10 | NUC-1 | **Cadastro completo do cidadão**: documentos, endereço com CEP (busca automática), domicílio e família, responsável, raça/cor, escolaridade, situação de rua; **unificação de cadastros duplicados** com histórico preservado; CPF como identificador | Dois cadastros da mesma pessoa viram um, e o prontuário mostra tudo; o cadastro atende aos campos da ficha de cadastro individual do e-SUS | |
| 4 (24 a 28/11) 🟡 entregue em 31/10, A1 | ATD-4 | **Assinatura ICP-Brasil**: certificado A1 no servidor (por profissional ou da instituição, guardado no R2 cifrado), assinatura de prontuário, receita, atestado e documentos em PAdES/CAdES; validação da assinatura; preparar A3/nuvem pelo navegador | Um documento assinado é validado pelo validador do ITI | Um certificado A1 de teste (ou real) para validar o fluxo |
| 5 (1 a 5/12) 🟡 entregue em 31/10, sem credenciamento | FAT-1, INT-1 | **BPA validado** com o layout oficial do DATASUS e uma competência de teste; **RNDS real**: credenciamento, certificado, validação dos perfis FHIR vigentes (RAC, imunização, dispensação, sumário) | Arquivo BPA aceito pelo SIA/validador; um RAC enviado ao ambiente de homologação da RNDS | Credenciamento do município na RNDS (certificado ICP-Brasil e-CNPJ, cadastro no portal de serviços do DATASUS) |

## Fase 2 (semanas 6 a 11): onda 1, Atenção Primária e financiamento

| Semana | Código | Entrega | Pronto quando | Precisa de você |
|---|---|---|---|---|
| 6 e 7 (8 a 19/12) 🟡 entregue em 31/10, sem PEC real | APS-1 | **Fichas e-SUS** geradas a partir do que já é registrado: cadastro individual e domiciliar, atendimento individual, odontológico, procedimentos, atividade coletiva, visita domiciliar, vacinação; exportação **LEDI** (Thrift) e envio pela API do PEC; tela de lotes, glosas e reprocessamento | O PEC e-SUS APS de teste aceita o lote sem glosa | Instalação do PEC de teste (posso subir uma aqui) e, para produção, as credenciais do PEC do município |
| 8 (22 a 26/12) 🟡 entregue em 31/10 | APS-2 | **Painel dos 15 indicadores do cofinanciamento** (Portaria 3.493/2024) com as fichas técnicas, resultado por equipe, lista nominal de quem falta (gestante sem consulta, diabético sem hemoglobina glicada...) e projeção do repasse | Os números batem com o cálculo manual numa equipe de teste | Conferir a lista vigente dos indicadores (última publicada em maio de 2025) |
| 9 e 10 (29/12 a 9/1) ✅ entregue em 31/10 | APS-4, APS-5 | **Programas da APS** com busca ativa: pré-natal, puericultura, HAS/DM, idoso, preventivo e mamografia, Bolsa Família, SISVAN, tuberculose/hanseníase; **estratificações** (gestante, pé diabético, M-CHAT) | Cada programa tem a lista de faltosos e alimenta o indicador correspondente | |
| 11 (12 a 16/1) ✅ entregue em 31/10 | APS-8 | **Vacinas**: calendário nacional por idade e estratégia, sala de vacina, aprazamento e faltosos, estoque por lote, envio ao SI-PNI via RNDS (RIA), certificado de vacinação | Uma dose aplicada aparece no cartão, abate o estoque e é aceita pela RNDS de homologação | |

## Fase 3 (semanas 12 a 18): onda 2, regulação e acesso

| Semana | Código | Entrega |
|---|---|---|
| 12 e 13 ✅ entregue em 31/10 | REG-1, REG-2 | Solicitações a partir do atendimento, protocolos por especialidade, classificação de prioridade, fila única, devolutiva (`docs/REGULACAO.md`) |
| 14 ✅ entregue em 31/10 | REG-3, REG-4 | PPI e cotas, contratos de prestadores, agendamento regulado, confirmação e remarcação (`docs/REGULACAO.md`) |
| 15 ✅ entregue em 31/10 | REG-5, REG-6 | TFD completo (laudo, envio, parecer, agendamento, ajuda de custo, impressão) e transporte sanitário (frota, motoristas, rotas, viagens, roteiro do dia, manutenção e abastecimento) (`docs/TFD-TRANSPORTE.md`) |
| 16 e 17 ✅ entregue em 31/10 | REG-7 | Regulação de leitos da rede (mapa, solicitação de vaga com NEWS2, fila por prioridade, segunda avaliação, reserva de leito, transferência, internação) e AIH (laudo, faixas numéricas, autorização com DV, espelho) (`docs/REGULACAO-LEITOS.md`) |
| 18 ✅ entregue em 31/10 | INT-5 | Envio da regulação à RNDS (Portaria 6.656/2025) no guia RIRA/MIRA oficial, com fila, conferência, reenvio e carga inicial; e-SUS Regulação sem API pública, conciliado por código externo (`docs/RNDS.md` §6) |

Em paralelo, na semana 12: **APS-3, app do ACS** (cadastro domiciliar, visitas, mapa, trabalho sem internet),
porque reaproveita o app Android já existente e é insumo dos indicadores. ✅ entregue em 31/10: tela
*Agente de saúde* com território, visitas, cadastros em campo, fila sem internet, mapa e produtividade; ficha
de visita no e-SUS; visitas nos indicadores e programas (`docs/ACS.md`).

## Fase 4 (semanas 19 a 22): onda 3, cidadão

| Semana | Código | Entrega |
|---|---|---|
| 19 e 20 ✅ entregue em 31/10 | CID-1 | App do cidadão em `/cidadao`: acesso por CPF, nascimento e código (WhatsApp ou recepção), agenda com confirmação, cancelamento, .ics e lembretes, exames, cartão de vacinas com certificado, remédios com estoque na rede, fila da regulação com posição, leitos, TFD, senha do dia e unidades (`docs/CIDADAO.md`) |
| 21 ✅ entregue em 31/10 | CID-2 | Assistente no WhatsApp: identificação pelo telefone com consentimento, menu e palavras-chave sem IA, modelo com saída estruturada quando a IA está ativa, agenda por conversa (marcar, confirmar, cancelar, remarcar), exames, vacinas, remédios, fila/TFD, senha, unidades, triagem com sinais de alerta que prevalecem, passagem para atendente e tela da equipe (`docs/ASSISTENTE-WHATSAPP.md`) |
| 22 ✅ entregue em 01/11 | CID-3, CID-4 | Ouvidoria (Lei 13.460/2017: protocolo, prazo de 30 dias prorrogável uma vez, anonimato, encaminhamento, resposta com aviso, avaliação, painel) pelos canais app, WhatsApp e balcão; pesquisa de satisfação após o atendimento (WhatsApp com botões e app com NPS, painel por unidade e profissional); Meu SUS Digital (prontidão por CPF/CNS e registros enviados à RNDS na ficha e no app) (`docs/OUVIDORIA.md`) |

## Fase 5 (semanas 23 a 30): onda 4, vigilância em saúde

Plano feito em 01/11/2026 a partir de fontes oficiais conferidas no texto (compilado da PRC GM/MS nº 4/2017 na
BVS, Portaria GM/MS nº 11.211/2026, notas técnicas do Ministério de 2024 a 2026, calendários do portal Sinan,
manuais do e-SUS Sinan e do e-SUS Notifica). Nenhum sistema federal da vigilância (Sinan Net, Sinan Online,
e-SUS Sinan, e-SUS Notifica, Sivep-Gripe) tem API de escrita confirmada: o caminho é registrar no OmniSaúde,
cumprir os prazos legais e entregar a fila de digitação e as exportações; a RNDS só recebe resultados de
laboratório de covid-19 e mpox (REL).

| Semana | Código | Entrega | Pronto quando | Precisa de você |
|---|---|---|---|---|
| 23 ✅ entregue em 01/11 | VIG-1a | **Notificação compulsória a partir do atendimento**: papéis de vigilância municipal e de núcleo do estabelecimento; semana epidemiológica; catálogo da Lista Nacional (Anexo 1 do Anexo V da PRC 4/2017) versionado e gerado do texto oficial (PRT 11.211/2026 e a anterior, 10.175/2026), com versões estadual e municipal; de-para CID-10/CIAP-2 → agravo; rascunho da ficha individual aberto sozinho ao assinar o registro com código notificável, no óbito e na internação, sem bloquear o atendimento; prazos de 24 h e 7 dias, ciência da SMS e repasse à SES e ao MS em 24 h; contatos do CIEVS; painel em tempo real e escalonamento; sigilo dos agravos sensíveis com leitura auditada (`docs/VIGILANCIA.md`) | O catálogo reproduz as 81 linhas e 66 itens da redação vigente; a semana epidemiológica bate com os calendários oficiais; um SOAP com coqueluche gera um único rascunho imediato com prazo de 24 h; a vigilância dá ciência e registra o repasse à SES; uma notificação de HIV não abre para outro médico | Técnicos da vigilância e dos núcleos hospitalares; contatos do CIEVS municipal e estadual e escala de plantão; lista complementar estadual ou municipal, se houver; um técnico para homologar o de-para de códigos |
| 24 ✅ entregue em 01/11 | VIG-1b, INT-4a | **Investigação, encerramento e saída para os sistemas oficiais**: tabela agravo → sistema de destino com vigência (Sinan Net, Sinan Online para dengue e chikungunya, e-SUS Sinan, e-SUS Notifica, Sivep-Gripe); fila "pendente de digitação" com o número oficial; espelho e PDF da ficha; exportação no dicionário de dados; encerramento genérico; gatilho por resultado de exame e por Srag; REL de covid-19 e mpox à RNDS; prazo de 24 h para comunicar a polícia na violência contra a mulher | Cada agravo cai na fila do sistema certo; informar o número oficial tira da fila; o REL é aceito pelo simulador | Acordo com a SES sobre quem digita em cada sistema; contas dos digitadores; credenciamento na RNDS; autoridade policial de referência |
| 25 ✅ entregue em 02/11 | PLT-3 | **Território georreferenciado e mapa de casos**: localidade, bairro, quarteirão e imóvel únicos (servem ao ACS, ao ACE e à vigilância sanitária); importação de malha GeoJSON (e shapefile em SIRGAS 2000, graus ou UTM); editor de quarteirões; geocodificação local com nível de precisão (base de endereços do IBGE, CNEFE 2022); mapa de casos só para a vigilância (`docs/TERRITORIO.md`) | Importar a malha liga cada domicílio ao seu quarteirão; um raio de 150 m devolve os quarteirões atingidos | Malha de bairros e quarteirões (ou aceite de desenhar no editor) |
| 26 ✅ entregue em 06/11 | VIG-3a | **Agente de combate às endemias em campo**: papéis ACE, supervisor e coordenador; visita no app sem internet (depósitos, focos, tratamento com baixa do larvicida por lote, pendências); bloqueio de transmissão aberto pelas notificações de dengue, chikungunya e Zika (raio de 150 m); ficha de visita do e-SUS APS (`docs/ENDEMIAS.md`) | Duas notificações próximas geram uma única ordem de bloqueio; o ACE trabalha sem rede e nada duplica ao sincronizar | ACE no CNES (CBO 515140); larvicida e estoque por lote; código de posturas; celulares com GPS |
| 27 (4 a 8/5) | VIG-1c | **Consolidação e detecção de surto**: importação e conciliação das exportações do Sinan e do e-SUS Notifica; diagrama de controle por agravo e território; estágios do plano de contingência; notificação de surto; notificação negativa semanal com atesto do responsável | O DBF do município importa sem duplicar; o diagrama bate com a planilha; a unidade silenciosa aparece | Exportações dos últimos 5 anos; plano municipal de contingência de arboviroses |
| 28 (11 a 15/5) | VIG-3b | **Ovitrampas, laboratório de entomologia e pontos estratégicos**: instalação e recolhimento, contagem de ovos, IPO/IDO/IDV, envio ao Conta Ovos; pontos estratégicos e imóveis especiais com periodicidade por risco | Os índices batem com o cálculo manual; o envio ao Conta Ovos (simulador) não duplica | Convite e chave do Conta Ovos; laboratorista; cadastro de pontos estratégicos |
| 29 (18 a 22/5) | VIG-4a | **Raiva, observação do animal, rumores e epizootias**: atendimento antirrábico com a conduta das notas técnicas vigentes, soro e vacina com aprazamento, observação de 10 dias do animal no app de campo, rumores vindos da ouvidoria, epizootias de notificação imediata | Cão observável não leva profilaxia; morcego indica soro e 4 doses com volume certo; epizootia vira notificação imediata | Nota estadual sobre soro e profilaxia; médico-veterinário; laboratório de referência |
| 30 (25 a 29/5) | VIG-2a | **Vigilância sanitária orientada a risco**: papéis de fiscal e coordenador; estabelecimento sobre o imóvel único; risco por CNAE (IN 66/2020 e normas locais); denúncia da ouvidoria vira ordem de serviço; roteiro de inspeção sem internet; termo de intimação e auto de infração assinados (Lei 6.437/1977); produção no BPA-C | Denúncia anônima vira ordem de serviço; o fiscal lavra o auto sem rede e o PDF assinado é validado | Código sanitário municipal e modelos de termo e auto; fiscais designados com certificado |

Depois da Fase 5, a **Onda 4b** (3 a 4 semanas) completa o que depende de atos locais ou de layouts ainda não
publicados: LIRAa/LIA, licenciamento sanitário e processo administrativo completo, livros da Portaria 344 e da
óptica, campanha antirrábica animal, leishmaniose visceral canina e unidade de vigilância de zoonoses.

## Depois (trimestres seguintes)

- **Onda 5, hospital e faturamento** (AIH/APAC/RAAS, centro cirúrgico, CCIH, prestadores): 8 semanas.
- **Onda 6, diagnóstico, farmácia estendida e gestão** (LIS, imagem, Hórus, SNCR, sala de situação, consórcio,
  CAPS, telessaúde): 10 semanas.
- Contínuo: certificação SBIS/CFM, LGPD, modo offline, APIs públicas, operação em várias instâncias.

## Insumos pendentes (lista viva)

A lista completa das ações que dependem da instituição, por fase e por prioridade (publicação, insumos, decisões,
contas, certificados, credenciamentos, homologações, aprovações e cadastros), com a fonte de cada item, está em
[`PENDENCIAS.md`](PENDENCIAS.md). A coluna *Insumos* de cada semana acima resume o que aquela entrega pede; ao
planejar uma semana nova, os insumos dela entram no `PENDENCIAS.md`.
