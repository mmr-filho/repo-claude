# Status em relação à especificação

Legenda: ✅ implementado e testado · 🟡 parcial (ver observação) · ⏳ pendente.
"Testado" quer dizer coberto por testes automatizados (bibliotecas e API contra Postgres real).

## 2. Dados, isolamento e infraestrutura

| Item | Status | Observação |
|---|---|---|
| `master_auth_db` com tenants, licenças, credenciamento e roteamento | ✅ | `packages/database/prisma/master` |
| Banco dedicado por tenant, migrações automatizadas | ✅ | provisionamento por CLI e por `POST /api/platform/tenants` |
| Réplica de leitura para BI/Text-to-SQL | ✅ | streaming no Docker Compose; papel `omni_bi` só lê as views `bi.*` |
| Prontuário transversal na rede do tenant | ✅ | linha do tempo única (`/patients/:id/timeline`) |
| NestJS + DDD + Prisma com conexões dinâmicas | ✅ | um `PrismaClient` por banco, LRU |
| Next.js 14+, Tailwind, componentes acessíveis | ✅ | Next 16, Tailwind 4, componentes próprios sobre Radix (padrão shadcn) |
| App Android (Capacitor) com câmera, leitor Datamatrix, microfone | 🟡 | projeto Capacitor e ponte nativa prontos; o APK precisa do Android SDK para compilar |
| Redis + BullMQ, WebSockets/SSE | ✅ | jobs de WhatsApp, RNDS e SIGTAP; Socket.IO para painel e censo; na Cloudflare, Cron Triggers |
| Cloudflare R2 | ✅ | API S3 com SHA-256 conferido na leitura |
| Docker multi-stage Debian-slim, Compose e Kubernetes | ✅ | manifestos k8s de referência (bancos e Redis como serviços gerenciados) |
| Publicação 100% Cloudflare (Workers, Containers, PlanetScale, R2) | 🟡 | `apps/cloudflare`; Worker e container testados localmente com `wrangler dev`; falta o primeiro deploy na conta |

## 3. IA multimodal e acessibilidade

| Item | Status | Observação |
|---|---|---|
| OCR de RG/CNH/certidão/cartão SUS com autopreenchimento | ✅ | Claude (multimodal) com saída estruturada; parser local para texto lido no aparelho |
| Validação síncrona com o CADSUS | ✅ | consulta `Patient` na RNDS; divergências e duplicidades apontadas |
| Interações medicamentosas graduadas, justificativa no grave | ✅ | base de conhecimento é semente: precisa de revisão da CFT |
| Protocolos por CID-10/CIAP-2 com exames SIGTAP | ✅ | códigos SIGTAP da semente devem ser conciliados com a tabela carregada |
| Speech-to-SOAP | ✅ | ditado no aparelho (Android/Web Speech) + estruturação por IA ou heurística; Whisper auto-hospedado opcional |
| Comandos de voz | ✅ | "chamar paciente", "prescrever...", "emitir atestado", "solicitar exame" |
| TTS no painel e em instruções | ✅ | síntese do navegador/Android |
| Avatar VLibras | 🟡 | widget oficial integrado; ele traduz o conteúdo da tela (não há API oficial de tradução de texto avulso) |
| Intérprete de Libras por vídeo (VRS/WebRTC) | 🟡 | central e sinalização prontas; central em memória (uma instância) e TURN a configurar |

## 4. Agendamento, WhatsApp e busca ativa

| Item | Status | Observação |
|---|---|---|
| Agendas, cotas de primeira consulta/retorno, bloqueios, absenteísmo | ✅ | |
| Confirmação 48h antes com botões, remarcação liberando vaga | ✅ | vaga cancelada é ofertada à lista de espera |
| Lembretes de adesão sincronizados com a prescrição | ✅ | |
| Janela de silêncio 22h–06h, adiando para 06h01 | ✅ | fuso por tenant |
| Painel de crônicos em atraso e busca ativa pelo serviço social | ✅ | |
| App do cidadão: acesso por código (WhatsApp ou recepção), agenda com confirmação/cancelamento e lembretes, exames, cartão de vacinas e certificado, remédios e estoque na rede, fila da regulação, leitos, TFD, senha do dia e unidades | ✅ | CID-1 (`docs/CIDADAO.md`); modelo `codigo_acesso` a aprovar na conta do WhatsApp |
| Assistente do cidadão no WhatsApp: entende por regras e por modelo (saída estruturada), responde com dados reais, marca/confirma/cancela/remarca por conversa, triagem com sinais de alerta, passagem para atendente | ✅ | CID-2 (`docs/ASSISTENTE-WHATSAPP.md`); áudio e imagem recebidos não são lidos |
| Ouvidoria (manifestação com protocolo, prazo legal de 30 dias prorrogável uma vez, anonimato, encaminhamento, resposta com aviso por WhatsApp, avaliação) e pesquisa de satisfação após o atendimento (WhatsApp com botões, app com NPS, painel) | ✅ | CID-3 (`docs/OUVIDORIA.md`); revisado por seis frentes com verificação cruzada (35 achados corrigidos); modelos `ouvidoria_resposta` e `pesquisa_satisfacao` a aprovar |
| Meu SUS Digital: prontidão por CPF/CNS e registros enviados à RNDS por tipo (com fila, erro temporário e recusados) na ficha do paciente e no app do cidadão | ✅ | CID-4; depende do credenciamento na RNDS para valer em produção |
| Unificação de cadastros move também regulação, leitos, AIH, TFD, transporte, visitas do ACS, estratificações, fichas e-SUS, documentos assinados, códigos e conversas do app/assistente, ouvidoria e pesquisas | ✅ | corrigido na revisão da semana 22 (antes só movia os registros dos módulos iniciais) |
| Notificação compulsória: catálogo da Lista Nacional versionado e gerado do texto oficial (PRT 11.211/2026 e a anterior 10.175/2026), listas estadual e municipal, de-para CID-10/CIAP-2 com homologação, rascunho aberto sozinho ao assinar, no óbito e na internação (sem bloquear o atendimento, com varredura de recuperação), ficha FIN do Sinan Net v5, prazos de 24 h e 7 dias, ciência da SMS e repasse em 24 h, escalonamento ao plantão, sigilo com leitura auditada | ✅ | VIG-1a (`docs/VIGILANCIA.md`); revisado por quatro frentes (regras, sigilo, integridade, web): 38 achados, cerca de 30 distintos, todos corrigidos e cobertos por testes; de-para a homologar pela vigilância; modelo `vigilancia_alerta` a aprovar |
| Notificação compulsória, saída e encerramento: rota agravo → sistema oficial com vigência (Sinan Net, Sinan Online para dengue e chikungunya, e-SUS Sinan, e-SUS Notifica, Sivep-Gripe; anomalia congênita só como lembrete da DNV/DO), fila de digitação com número oficial conferido por sistema (NU_NOTIFIC do Sinan Net pela chave número + data + município + agravo), espelho e PDF na ordem da FIN v5, exportação CSV no dicionário de dados, investigação e encerramento (bloco genérico do Sinan Net e campos 44 a 56 do e-SUS Sinan), gatilho por resultado de exame e por Srag (NT 11/2026), comunicação policial em 24 h na violência contra a mulher de 18 a 59 anos, sem identificar a vítima; PDFs não assinados deixam de se declarar assinados | ✅ | VIG-1b (`docs/VIGILANCIA.md`, semana 24); revisado por quatro frentes (regras, sigilo, integridade, web): 38 achados confirmados, cerca de 25 distintos, todos corrigidos e cobertos por testes; não há API de escrita nos sistemas oficiais (digitação); formatos de número do Sinan Online e do e-SUS Notifica sem documento nacional (validação larga); exclusão da lesão autoprovocada da comunicação policial é interpretação a validar; destino da caxumba a definir com a SES; autoridade policial de referência e modelo da comunicação a definir |
| Território georreferenciado: localidade (código PNCD), bairro com apelidos, quarteirão com contorno e número na regra da instituição (por localidade ou por bairro), imóvel com quarteirão, sequência e precisão da posição; importação de malha GeoJSON e shapefile (SIRGAS 2000 em graus ou UTM 17S a 25S, reprojetado; SAD69 recusado) com prévia, sugestão de colunas e religação de todos os imóveis; editor com recusa de sobreposição e controle de versão; geocodificação só local pelo CNEFE 2022 (endereço, quadra e lote, rua, bairro), sem nunca piorar a precisão; raio do bloqueio (150 m, configurável) até a borda dos quarteirões; mapa de casos só para a vigilância, sem nome, com agravo sigiloso restrito e consulta auditada | ✅ | PLT-3 (`docs/TERRITORIO.md`, semana 25); revisado em duas rodadas (geometria, importação, segurança, dados, web; depois API, integração, web e evidências): os achados confirmados, entre eles um XSS nas dicas do mapa e o ACS fora da sua área, foram corrigidos; os da API e da biblioteca têm testes automatizados, os da web foram conferidos no navegador (a web não tem testes unitários); geometria no próprio código (sem PostGIS); malha real e base do CNEFE do município a enviar pela instituição |

## 5. Gestão e BI

| Item | Status | Observação |
|---|---|---|
| Produtividade por profissional, categoria e unidade | ✅ | |
| SLAs e não conformidades | ✅ | |
| Gerador de pautas de reunião | ✅ | determinístico (sem depender de IA) |
| BI conversacional com Text-to-SQL blindado por AST | ✅ | exemplo da especificação devolve exatamente os pacientes esperados |
| Exportação CSV / PDF / dashboards | 🟡 | CSV no servidor; PDF pela impressão do navegador; gráficos sugeridos pela IA |

## 6. Governança de acesso e auditoria

| Item | Status | Observação |
|---|---|---|
| Sessão com Tenant + Unidade + Papel, 9 papéis | ✅ | Serviço Social separado da equipe multiprofissional |
| Mapa topográfico da dor e escala 0–10 | ✅ | |
| ACCR em 5 cores | ✅ | sugestão automática + justificativa para classificar abaixo |
| POPs hard gate (checklist + dupla checagem) e soft gate (acesso auditado) | ✅ | |
| Hash SHA-256 (conteúdo + UTC + IP + 2FA) encadeado e imutável | ✅ | gatilhos no banco; verificação da cadeia |
| Assinatura ICP-Brasil (A1/A3/nuvem) | 🟡 | A1 pronto: certificado do profissional guardado cifrado, PDF assinado em PAdES (CAdES-BES com signing-certificate-v2), validador interno com as raízes da ICP-Brasil; A3 (token/cartão) e nuvem ficam para uma próxima etapa, e falta conferir um documento no validador do ITI com um certificado real |

## 7. Medicamentos e suprimentos

| Item | Status | Observação |
|---|---|---|
| NF-e por webservice da SEFAZ e upload de XML | 🟡 | upload completo; consulta à SEFAZ implementada contra o mock REST (o serviço real é SOAP com mTLS) |
| De-Para com CATMAT | ✅ | |
| Leitura obrigatória do `<rastro>` | ✅ | |
| Transferências com dupla conferência | ✅ | |
| Unitarização com Datamatrix GS1 e validade recalculada | ✅ | |
| Dispensação ambulatorial e Portaria 344 | ✅ | relatório de controlados por período |
| Administração beira-leito com 5 certos e baixa no ato | ✅ | |
| Logística reversa | ✅ | doses não ficam vinculadas ao paciente (vínculo por prescrição) |

## 8. Faturamento e interoperabilidade

| Item | Status | Observação |
|---|---|---|
| Sincronização mensal da SIGTAP e contingência por zip | ✅ | mapeamento de instrumentos é premissa documentada |
| Crítica pré-glosa (CBO, CID, sexo, idade, quantidade) | ✅ | |
| BPA-I e BPA-C | 🟡 | layout conferido campo a campo com o documento oficial do DATASUS (Layout de Exportação do BPA, com CPF do indivíduo e situação de rua, vigente desde 12/2024); numéricos opcionais em branco, CNS ou CPF (nunca os dois), INE da equipe; conferência automática do arquivo gerado e de arquivos externos; falta importar uma competência real no BPA Magnético |
| Laudo APAC e lote AIH | ⏳ | laudo e autorização de AIH prontos (REG-7); geração dos arquivos (SISAIH01/APAC) pendente |
| RNDS: RAC, imunização, dispensação, sumário de alta (FHIR + mTLS) | 🟡 | cabeçalhos, token e endereços conforme o guia e a coleção oficial (CNS do solicitante, ambientes de homologação/produção por UF); perfis do RAC conferidos com o pacote oficial; imunização, dispensação e sumário de alta a confirmar na homologação; teste de conexão em Administração > Integrações; falta o credenciamento (`docs/RNDS.md`) |
| e-SUS APS (LEDI/Thrift) e API do PEC | 🟡 | `packages/esus` + `modules/esus`; seis modelos de informação; visita domiciliar e atividade coletiva aguardam as fontes (APS-3, APS-7); homologação num PEC real pendente |
| Indicadores do cofinanciamento da APS | 🟡 | `packages/shared/src/aps-indicadores.ts` + `modules/indicators`; apuração própria a partir dos registros (não substitui o Siaps) |
| Consulta CADSUS | ✅ | |
| Envio da regulação à RNDS (Portaria GM/MS 6.656/2025): Registro de Regulação Assistencial (RIRA/MIRA) para solicitações ambulatoriais e de vaga de leito, um documento por mudança de situação, validação, fila com novas tentativas, painel de conferência, pré-visualização do FHIR, reenvio e carga inicial | ✅ | INT-5; substituição do documento anterior e identificadores a confirmar na homologação (`docs/RNDS.md` §6) |
| RNDS: resultado de exame laboratorial (REL 3.2.1) de covid-19 e mpox, todo resultado, pela fila com novas tentativas | 🟡 | INT-4a; perfis do projeto público da RNDS no Simplifier, validação própria e aceite pelo simulador; desligado de saída (`relEnabled`); REL v4 e credenciamento pendentes (`docs/VIGILANCIA.md`) |
| Integração com SISREG / e-SUS Regulação | 🟡 | sem API pública (FAQ e wiki do MS só tratam de adesão); pela Portaria 6.656 o caminho dos sistemas próprios é a RNDS; o código externo da solicitação permite conciliar os registros |

## Front-end (web e Android)

| Tela | Status | Observação |
|---|---|---|
| Login em etapas, troca de unidade/papel, menu por permissão | ✅ | |
| Administração: unidades, profissionais e lotações, senha provisória, 2FA obrigatório por papel | ✅ | NUC-6 do roadmap; cadastro pela tela sem depender da carga de demonstração; desativar vale na hora |
| Importação do CNES: estabelecimentos (API do DATASUS, conciliação e aplicação seletiva), equipes INE e profissionais por planilha, pré-cadastro e acessos em lote | 🟡 | NUC-2/3; falta o arquivo "XML e-SUS AB" do CNES (profissionais e equipes oficiais): layout não publicado, precisa de um exemplo do município |
| Assinatura digital ICP-Brasil (A1 no servidor): certificado em Minha conta, "Assinar com certificado" no registro do prontuário, na receita e no atestado, PDF/PAdES para baixar, página "Validar documento" para qualquer usuário conferir um PDF | 🟡 | ATD-4; testado com certificado de teste no formato e-CPF (CPF no campo 2.16.76.1.3.1) e com o OpenSSL (`cms -verify -cades`); falta um A1 real para conferir no validador do ITI; A3/nuvem depois |
| Faturamento: conferência de arquivos BPA (gerados aqui ou de fora) contra o layout oficial, com erros por linha e campo | ✅ | FAT-1; a tela de Arquivos BPA mostra o laudo da conferência |
| Administração > Integrações: situação da RNDS (ambiente, endereços, solicitante, certificado, fila) e teste de conexão | ✅ | INT-1; o envio real depende do credenciamento |
| e-SUS APS: lotes de fichas LEDI 8.7.0 (cadastro individual e domiciliar, atendimento individual e odontológico, procedimentos, vacinação, visita domiciliar), validação prévia, .zip, envio pela API do PEC, recusas e reprocessamento | 🟡 | APS-1; Thrift próprio conferido com a implementação de referência e o código oficial; falta receber um lote num PEC real (`docs/ESUS.md`) |
| Indicadores APS: os 15 indicadores do componente de qualidade por equipe e competência (NT 8/2026 e notas metodológicas de 2026), quem falta por boa prática, projeção do repasse, modalidade da equipe, desfecho de condição | 🟡 | APS-2; números conferidos com cálculo manual numa equipe de teste; visitas do ACS apuradas desde APS-3; atividades coletivas sem fonte até APS-7 (`docs/INDICADORES-APS.md`) |
| Programas APS: pré-natal, puericultura, HAS/DM, idoso, preventivo e mamografia, Bolsa Família, SISVAN, tuberculose/hanseníase com lista de faltosos por ação programática, busca ativa a partir da lista e estratificações (risco gestacional, pé diabético, M-CHAT-R) | ✅ | APS-4/APS-5; visitas do ACS entram nas faltas desde APS-3; atividades coletivas com APS-7 (`docs/PROGRAMAS-APS.md`) |
| Vacinas: sala de vacina com cartão e aprazamento pelo Calendário Nacional, aplicação com baixa do lote, transcrição da caderneta, RNDS (RIA) com códigos, certificado em PDF assinável, agenda de aprazamentos, faltosos e estoque por lote | ✅ | APS-8; aceitação pela RNDS de homologação depende do credenciamento (`docs/VACINAS.md`) |
| App do ACS: papel ACS, território por microárea com prioridades e última visita, visitas domiciliares e territoriais, cadastro domiciliar e individual em campo, fila sem internet (IndexedDB) com sincronização idempotente, mapa (Leaflet/OSM), produtividade por agente; ficha de visita no e-SUS; visitas nos indicadores e programas | ✅ | APS-3; mesma tela no app Android (Capacitor); testado com a rede desligada no navegador (`docs/ACS.md`) |
| Regulação ambulatorial: solicitação a partir do atendimento com protocolo de encaminhamento por especialidade (critérios, exames mínimos conferidos no prontuário), prioridade com prazo-meta e justificativa, fila única por prioridade e ordem de chegada, análise/autorização (com reclassificação e unidade executante)/devolução/negativa, complementação pela unidade, mensagens, devolutiva em tempo real e por WhatsApp, painel e linha do tempo | ✅ | REG-1/REG-2; agendamento regulado, cotas e prestadores em REG-3/REG-4 (`docs/REGULACAO.md`) |
| Regulação, prestadores e agendamento regulado: prestadores próprios e contratados com contrato e tetos físico/financeiro, PPI e cotas por competência, especialidade e origem, consumo na autorização, agendamento na agenda do executante com confirmação WhatsApp, remarcação, desmarcação, falta, conclusão e tempos médios por prestador | ✅ | REG-3/REG-4; prestador externo sem agenda no sistema fica só autorizado (`docs/REGULACAO.md`) |
| TFD: laudo médico com CID, procedimento, justificativa, destino, transporte e acompanhante; número de processo; envio à regional; parecer (deferido/indeferido, ajuda de custo aprovada, transporte); agendamento no destino; ajuda de custo por beneficiário com pagamento; reserva de transporte sanitário; histórico, devolutiva WhatsApp, PDFs do laudo e da guia de viagem; linha do tempo | ✅ | REG-5; o envio à regional é registrado, não transmitido (`docs/TFD-TRANSPORTE.md`) |
| Transporte sanitário: frota (tipos, lugares, acessibilidade, odômetro, manutenção prevista), motoristas (CNH com alerta de validade), rotas recorrentes com pontos de embarque, viagens (iniciar/concluir com odômetro e abastecimento, cancelar), passageiros com lotação e acessibilidade, embarque/falta, roteiro do dia, registros de manutenção e abastecimento, consumo médio e indicadores por veículo | ✅ | REG-6; sem roteirização geográfica (`docs/TFD-TRANSPORTE.md`) |
| Central de leitos da rede: mapa de leitos de hospitais e UPAs, solicitação de vaga com sinais vitais (NEWS2), suporte e prioridade sugerida, fila por prioridade e tempo, análise, devolução/complementação, segunda avaliação por outro regulador, autorização com destino e reserva de leito (status Reservado no censo), transferência com transporte, internação pela central ou pelo censo, negativa, cancelamento, ficha PDF, painel e linha do tempo | ✅ | REG-7; sem integração com SISREG/CROSS (`docs/REGULACAO-LEITOS.md`) |
| AIH: laudo médico (SIGTAP, CIDs, especialidade do leito, caráter, sinais, condições, provas), autorização com número da faixa do gestor ou manual com dígito verificador, validade, negativa, cancelamento, faixas numéricas, PDF e número no espelho de faturamento | ✅ | REG-7; lote SISAIH01 fica em FAT-2 (`docs/REGULACAO-LEITOS.md`) |
| Cadastro completo do cidadão: documentos (RG, NIS), dados sociais (escolaridade, trabalho, ocupação, situação de rua), endereço com CEP automático, domicílio e família (cadastro domiciliar do e-SUS), unificação de cadastros duplicados | ✅ | NUC-1; o cadastro unificado redireciona para o que ficou e leva o histórico junto |
| App do cidadão (`/cidadao`, celular): entrada por CPF, nascimento e código de 6 dígitos; início com senha do dia, próximo compromisso e pendências; agenda (confirmar, cancelar, salvar .ics, lembretes WhatsApp); exames; vacinas com próximas doses e certificado PDF; remédios com posologia simples e onde há estoque; fila da regulação com posição, leitos e TFD; unidades com "como chegar"; botão "Código do app" na ficha do paciente | ✅ | CID-1; sessão própria (localStorage), rotas `/api/cidadao/*` isoladas por token |
| Assistente WhatsApp (`/assistente`): painel (conversas, aguardando atendente, consultas marcadas por conversa, triagens), lista com filtro e busca, transcrição com intenção por mensagem, resposta humana pelo mesmo número e encerramento | ✅ | CID-2; atualiza em tempo real |
| Ouvidoria (`/ouvidoria`): painel de prazos, lista com filtros, detalhe com linha do tempo, registrar no balcão/telefone, encaminhar, prorrogar, responder, arquivar; aba Pesquisa de satisfação com distribuição, NPS, por unidade e por profissional; no app do cidadão: nova manifestação (inclusive anônima), acompanhamento, avaliação da resposta, pesquisa de satisfação com NPS e cartão Meu SUS Digital | ✅ | CID-3/CID-4 |
| Vigilância (`/vigilancia`): painel com cartões (imediatas aguardando ciência, repasses, vencidas), lista com a ficha ao lado, minhas notificações, descartes, lista LNNC com versões e lista local, de-para de códigos com homologação em lote, plantão e contatos; ficha com contagem regressiva por esfera, edição, confirmação, ciência, comunicação e linha do tempo; aviso após assinar no atendimento, cartão no paciente e "Notificar ESAVI" na vacina; resumo só com contagens para a gestão | ✅ | VIG-1a; atualiza em tempo real |
| Vigilância, semana 24: abas *Digitação* (fila por sistema, número e lote) e *Sistemas* (rotas com vigência), exportação CSV, sugestões de Srag, cartões de digitação, encerramento vencido e comunicações policiais; na ficha, sistema oficial, espelho e PDF, encerramento e reabertura, comunicação policial (PDF, envio, dispensa) e orientação ECA/Estatuto da Pessoa Idosa; no atendimento, laudo com exame de vigilância e resultado qualitativo | ✅ | VIG-1b |
| Território (`/territorio`): resumo, mapa (quarteirões, rótulos, imóveis pela precisão, raio do bloqueio, desenho e edição do contorno, marcar imóvel), localidades e bairros, importação com prévia e histórico, pendências dos imóveis e configuração; Vigilância > *Mapa de casos* com raio e quarteirões atingidos; na ficha, cartão "Quarteirões no raio do bloqueio" | ✅ | PLT-3; Leaflet + Leaflet-Geoman sobre o OpenStreetMap |
| Recepção (OCR, CADSUS, duplicidade, senhas, acolhimento, pulseira) | ✅ | |
| Painel de chamada (TV) com voz | ✅ | exige um clique para liberar o som (regra dos navegadores) |
| Classificação de risco com mapa corporal 2D e escala 0–10 | ✅ | |
| Atendimento: SOAP com ditado, comandos de voz, prescrição com copiloto, exames, protocolos, atestado | ✅ | ditado por microfone verificado só fora do navegador automatizado |
| Agenda, lista de espera, absenteísmo, nova agenda | ✅ | |
| Prontuário do paciente com linha do tempo da rede | ✅ | |
| Farmácia (estoque, NF-e/De-Para, transferências, etiquetas Datamatrix, dispensação, controlados) | ✅ | |
| Beira-leito (leitura de pulseira e dose, POP com dupla checagem, 5 certos com som) | ✅ | |
| Leitos (censo em tempo real, internação, transferência, alta, leito reservado pela central) | ✅ | |
| Faturamento, gestão, BI conversacional, busca ativa, POPs, auditoria | ✅ | BI sem chave de IA oferece consultas prontas |
| Chamada de intérprete de Libras | 🟡 | fila e sinalização verificadas; vídeo não testado sem intérprete conectado |
| App Android (Capacitor) | 🟡 | projeto nativo gerado e sincronizado (câmera, microfone, ML Kit, GPS); a tela do ACS trabalha sem internet; APK não compilado aqui por falta do Android SDK |

## Verificação feita

- 570 testes automatizados em 78 arquivos (bibliotecas, simulador, Worker da Cloudflare e API contra PostgreSQL
  real), na rodada de 06/11/2026 às 17h UTC (14h de Brasília): todos passando. Com o relógio do processo em 22h45
  de Brasília, falham os que dependem da hora: a devolutiva da regulação e do TFD por WhatsApp (janela de
  silêncio das 22h às 6h locais) e 9 da saída da vigilância; em 02/11, faturamento e agenda também falharam
  nesse horário. A apuração dos indicadores, as listas dos programas e o encerramento de condição sem data
  seguem o dia local da instituição (`docs/INDICADORES-APS.md`, `docs/PROGRAMAS-APS.md`).
- Teste de fumaça com Playwright (`e2e/smoke.e2e.mjs`) percorrendo 16 telas com 9 papéis no build de produção.
- Território no navegador (semana 25): localidade e bairros com apelido, importação de 30 quarteirões em GeoJSON com
  os 11 imóveis ligados, raio de 150 m, quarteirão desenhado no editor (rascunho visível e editável antes de salvar),
  base do CNEFE importada, imóveis localizados pelo endereço e marcados no mapa, endereço com HTML exibido como texto
  (sem executar), mapa de casos da vigilância com o raio do caso e os pontos clicáveis por cima da malha; a médica
  não vê a aba nem o menu e a API responde 403.
- Fluxo de administração no navegador: a gestora cadastra uma unidade e um profissional, recebe a senha
  provisória, o profissional entra, só vê "Minha conta" até trocar a senha e depois acessa a Recepção.
- Importação do CNES no navegador contra a API real do DATASUS: os 293 estabelecimentos de Gurupi/TO
  (IBGE 1709500) listados e conciliados, as unidades públicas criadas com tipo, contato, horário e coordenadas.
- Faturamento no navegador: crítica, arquivo BPA-I gerado (cabeçalho 130, registro 350 posições) e conferido
  na tela, inclusive com o campo de controle adulterado; Administração > Integrações com teste de conexão à RNDS
  (simulador)
- Assinatura digital no navegador: certificado cadastrado em Minha conta, registro do prontuário assinado com
  o certificado (PDF baixado), receita assinada e o PDF validado em "Validar documento" (adulteração detectada)
- Cidadão no navegador: domicílio criado a partir do endereço, membro incluído com parentesco, condições de
  moradia editadas, CEP preenchendo logradouro, município, UF e IBGE, e dois cadastros duplicados unificados.
- App do cidadão no navegador (viewport de celular): recepção emite o código na ficha do paciente; o cidadão pede o
  código pelo WhatsApp (simulador), erra uma vez, entra, vê senha do dia, próximo compromisso e pendências, confirma
  presença, salva o .ics, cancela com motivo, percorre exames, vacinas (certificado em PDF), remédios, fila com
  posição e unidades, sai e entra de novo com o código da recepção; o token do cidadão é recusado nas rotas de
  profissional.
- Assistente do WhatsApp no navegador: conversa simulada pelo webhook (saudação, agenda, oferta de horários e
  marcação por botão, triagem com emergência, pedido de atendente) aparece na tela da recepção com a intenção de
  cada mensagem; a recepção responde pela tela e a mensagem sai pelo WhatsApp simulado.
- Vigilância no navegador: a médica assina um SOAP com A37.9 e vê o aviso do rascunho imediato de coqueluche,
  abre a ficha, informa os sintomas e confirma; a vigilância municipal vê o cartão "imediatas aguardando ciência",
  dá ciência e registra o repasse por telefone ao CIEVS estadual (SMS e SES cumpridas); a enfermeira vê a
  notificação de HIV de outro profissional como "agravo de acesso restrito" na ficha do paciente; a gestora vê só
  as contagens; a ficha cabe na largura do celular.
- Ouvidoria no navegador: cidadão registra manifestação anônima pelo app; a gestora vê a manifestação sem
  identidade na tela, encaminha, responde e a resposta aparece no app do cidadão, que avalia; a pesquisa de
  satisfação do atendimento encerrado é respondida no app e o painel mostra a nota, o NPS e o comentário.
- Imagem Docker da API construída e executada: migrações, login com contexto e consulta de BI na conexão
  somente leitura.
- Exportação estática do front-end e `cap sync android` concluídos.
- Publicação na Cloudflare com `wrangler dev` e a imagem real da API: primeira partida num PostgreSQL vazio
  com papel administrador sem superusuário (como o do PlanetScale), login e contexto no navegador, WebSocket
  por `/omnisaude/socket.io`, CADSUS simulado, Cron Trigger chamando os jobs, `/api/jobs/tick` bloqueado ao
  público e reinício da API quando a configuração do Worker muda. `wrangler deploy --dry-run` aceita a
  configuração. O build da imagem pela Cloudflare e o PlanetScale real não foram exercitados aqui.

## Próximos passos

O plano completo, comparado com Celk, Inovadora e MV e organizado em ondas, está em [`ROADMAP.md`](ROADMAP.md).
Em resumo, a onda 0 (pré-requisitos para uso real) é: telas de administração de unidades e profissionais,
importação do CNES, cadastro completo do cidadão, assinatura ICP-Brasil, validação do BPA e credenciamento na
RNDS; em paralelo, o envio ao e-SUS APS e o painel dos indicadores do cofinanciamento.
