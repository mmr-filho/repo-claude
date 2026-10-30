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
| 1 (3 a 7/11) | NUC-6 | Área **Administração** no sistema: unidades (cadastro, tipo, CNES, horário), profissionais (CPF, nome, CNS, conselho/registro, CBO, e-mail, telefone), lotações (unidade + papel + CBO), ativar/desativar, redefinição de senha com senha provisória, 2FA obrigatório por papel, usuários de plataforma | O gestor cadastra uma unidade e um profissional novos pela tela e esse profissional entra no sistema sem a carga de demonstração | Decidir quais papéis exigem 2FA (sugestão: gestão, faturamento, farmácia e médico) |
| 2 (10 a 14/11) | NUC-2/3 | **Importação do CNES**: estabelecimentos, profissionais, vínculos e equipes (INE) a partir do arquivo mensal do CNES ou da API do DATASUS, com conciliação (o que é novo, o que mudou, o que sumiu) e revisão antes de aplicar | Importar o CNES de um município real cria as unidades e os profissionais corretos, sem duplicar os existentes | Código IBGE do município de teste; se houver, o arquivo do CNES baixado do portal |
| 3 (17 a 21/11) | NUC-1 | **Cadastro completo do cidadão**: documentos, endereço com CEP (busca automática), domicílio e família, responsável, raça/cor, escolaridade, situação de rua; **unificação de cadastros duplicados** com histórico preservado; CPF como identificador | Dois cadastros da mesma pessoa viram um, e o prontuário mostra tudo; o cadastro atende aos campos da ficha de cadastro individual do e-SUS | |
| 4 (24 a 28/11) | ATD-4 | **Assinatura ICP-Brasil**: certificado A1 no servidor (por profissional ou da instituição, guardado no R2 cifrado), assinatura de prontuário, receita, atestado e documentos em PAdES/CAdES; validação da assinatura; preparar A3/nuvem pelo navegador | Um documento assinado é validado pelo validador do ITI | Um certificado A1 de teste (ou real) para validar o fluxo |
| 5 (1 a 5/12) | FAT-1, INT-1 | **BPA validado** com o layout oficial do DATASUS e uma competência de teste; **RNDS real**: credenciamento, certificado, validação dos perfis FHIR vigentes (RAC, imunização, dispensação, sumário) | Arquivo BPA aceito pelo SIA/validador; um RAC enviado ao ambiente de homologação da RNDS | Credenciamento do município na RNDS (certificado ICP-Brasil e-CNPJ, cadastro no portal de serviços do DATASUS) |

## Fase 2 (semanas 6 a 11): onda 1, Atenção Primária e financiamento

| Semana | Código | Entrega | Pronto quando | Precisa de você |
|---|---|---|---|---|
| 6 e 7 (8 a 19/12) | APS-1 | **Fichas e-SUS** geradas a partir do que já é registrado: cadastro individual e domiciliar, atendimento individual, odontológico, procedimentos, atividade coletiva, visita domiciliar, vacinação; exportação **LEDI** (Thrift) e envio pela API do PEC; tela de lotes, glosas e reprocessamento | O PEC e-SUS APS de teste aceita o lote sem glosa | Instalação do PEC de teste (posso subir uma aqui) e, para produção, as credenciais do PEC do município |
| 8 (22 a 26/12) | APS-2 | **Painel dos 15 indicadores do cofinanciamento** (Portaria 3.493/2024) com as fichas técnicas, resultado por equipe, lista nominal de quem falta (gestante sem consulta, diabético sem hemoglobina glicada...) e projeção do repasse | Os números batem com o cálculo manual numa equipe de teste | Conferir a lista vigente dos indicadores (última publicada em maio de 2025) |
| 9 e 10 (29/12 a 9/1) | APS-4, APS-5 | **Programas da APS** com busca ativa: pré-natal, puericultura, HAS/DM, idoso, preventivo e mamografia, Bolsa Família, SISVAN, tuberculose/hanseníase; **estratificações** (gestante, pé diabético, M-CHAT) | Cada programa tem a lista de faltosos e alimenta o indicador correspondente | |
| 11 (12 a 16/1) | APS-8 | **Vacinas**: calendário nacional por idade e estratégia, sala de vacina, aprazamento e faltosos, estoque por lote, envio ao SI-PNI via RNDS (RIA), certificado de vacinação | Uma dose aplicada aparece no cartão, abate o estoque e é aceita pela RNDS de homologação | |

## Fase 3 (semanas 12 a 18): onda 2, regulação e acesso

| Semana | Código | Entrega |
|---|---|---|
| 12 e 13 | REG-1, REG-2 | Solicitações a partir do atendimento, protocolos por especialidade, classificação de prioridade, fila única, devolutiva |
| 14 | REG-3, REG-4 | PPI e cotas, contratos de prestadores, agendamento regulado, confirmação e remarcação |
| 15 | REG-5, REG-6 | TFD completo e transporte sanitário (frota, rotas, viagens) |
| 16 e 17 | REG-7 | Regulação de leitos da rede e AIH |
| 18 | INT-5 | Envio da regulação à RNDS (Portaria 6.656/2025) e integração com o e-SUS Regulação conforme a documentação do DATASUS |

Em paralelo, na semana 12: **APS-3, app do ACS** (cadastro domiciliar, visitas, mapa, trabalho sem internet),
porque reaproveita o app Android já existente e é insumo dos indicadores.

## Fase 4 (semanas 19 a 22): onda 3, cidadão

| Semana | Código | Entrega |
|---|---|---|
| 19 e 20 | CID-1 | App do cidadão: agenda e lembretes, cancelamento, exames, cartão de vacinas, medicamentos, fila e TFD |
| 21 | CID-2 | Assistente com IA no WhatsApp: dúvidas, orientação, agendamento por conversa, triagem |
| 22 | CID-3, CID-4 | Ouvidoria, pesquisa de satisfação, compatibilidade com o Meu SUS Digital |

## Depois (trimestres seguintes)

- **Onda 4, vigilância** (epidemiológica/SINAN, sanitária, endemias, zoonoses): 8 semanas.
- **Onda 5, hospital e faturamento** (AIH/APAC/RAAS, centro cirúrgico, CCIH, prestadores): 8 semanas.
- **Onda 6, diagnóstico, farmácia estendida e gestão** (LIS, imagem, Hórus, SNCR, sala de situação, consórcio,
  CAPS, telessaúde): 10 semanas.
- Contínuo: certificação SBIS/CFM, LGPD, modo offline, APIs públicas, operação em várias instâncias.

## Insumos pendentes (lista viva)

| Insumo | Para | Situação |
|---|---|---|
| Papéis com 2FA obrigatório | NUC-6 (semana 1) | aguardando decisão (há sugestão) |
| Código IBGE / arquivo CNES do município de teste | NUC-2/3 (semana 2) | aguardando |
| Certificado A1 de teste | ATD-4 (semana 4) | aguardando |
| Credenciamento na RNDS (homologação) | INT-1 (semana 5) | aguardando |
| Acesso a um PEC e-SUS APS (teste e produção) | APS-1 (semanas 6 e 7) | posso subir um de teste aqui |
