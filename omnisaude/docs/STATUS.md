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
| Laudo APAC e lote AIH | ⏳ | há o espelho de AIH; geração dos arquivos pendente |
| RNDS: RAC, imunização, dispensação, sumário de alta (FHIR + mTLS) | 🟡 | cabeçalhos, token e endereços conforme o guia e a coleção oficial (CNS do solicitante, ambientes de homologação/produção por UF); perfis do RAC conferidos com o pacote oficial; imunização, dispensação e sumário de alta a confirmar na homologação; teste de conexão em Administração > Integrações; falta o credenciamento (`docs/RNDS.md`) |
| Consulta CADSUS | ✅ | |
| Integração com a central de vagas (SISREG) | ⏳ | só o código de regulação na internação; o SISREG não tem API pública |

## Front-end (web e Android)

| Tela | Status | Observação |
|---|---|---|
| Login em etapas, troca de unidade/papel, menu por permissão | ✅ | |
| Administração: unidades, profissionais e lotações, senha provisória, 2FA obrigatório por papel | ✅ | NUC-6 do roadmap; cadastro pela tela sem depender da carga de demonstração; desativar vale na hora |
| Importação do CNES: estabelecimentos (API do DATASUS, conciliação e aplicação seletiva), equipes INE e profissionais por planilha, pré-cadastro e acessos em lote | 🟡 | NUC-2/3; falta o arquivo "XML e-SUS AB" do CNES (profissionais e equipes oficiais): layout não publicado, precisa de um exemplo do município |
| Assinatura digital ICP-Brasil (A1 no servidor): certificado em Minha conta, "Assinar com certificado" no registro do prontuário, na receita e no atestado, PDF/PAdES para baixar, página "Validar documento" para qualquer usuário conferir um PDF | 🟡 | ATD-4; testado com certificado de teste no formato e-CPF (CPF no campo 2.16.76.1.3.1) e com o OpenSSL (`cms -verify -cades`); falta um A1 real para conferir no validador do ITI; A3/nuvem depois |
| Faturamento: conferência de arquivos BPA (gerados aqui ou de fora) contra o layout oficial, com erros por linha e campo | ✅ | FAT-1; a tela de Arquivos BPA mostra o laudo da conferência |
| Administração > Integrações: situação da RNDS (ambiente, endereços, solicitante, certificado, fila) e teste de conexão | ✅ | INT-1; o envio real depende do credenciamento |
| Cadastro completo do cidadão: documentos (RG, NIS), dados sociais (escolaridade, trabalho, ocupação, situação de rua), endereço com CEP automático, domicílio e família (cadastro domiciliar do e-SUS), unificação de cadastros duplicados | ✅ | NUC-1; o cadastro unificado redireciona para o que ficou e leva o histórico junto |
| Recepção (OCR, CADSUS, duplicidade, senhas, acolhimento, pulseira) | ✅ | |
| Painel de chamada (TV) com voz | ✅ | exige um clique para liberar o som (regra dos navegadores) |
| Classificação de risco com mapa corporal 2D e escala 0–10 | ✅ | |
| Atendimento: SOAP com ditado, comandos de voz, prescrição com copiloto, exames, protocolos, atestado | ✅ | ditado por microfone verificado só fora do navegador automatizado |
| Agenda, lista de espera, absenteísmo, nova agenda | ✅ | |
| Prontuário do paciente com linha do tempo da rede | ✅ | |
| Farmácia (estoque, NF-e/De-Para, transferências, etiquetas Datamatrix, dispensação, controlados) | ✅ | |
| Beira-leito (leitura de pulseira e dose, POP com dupla checagem, 5 certos com som) | ✅ | |
| Leitos (censo em tempo real, internação, transferência, alta) | ✅ | |
| Faturamento, gestão, BI conversacional, busca ativa, POPs, auditoria | ✅ | BI sem chave de IA oferece consultas prontas |
| Chamada de intérprete de Libras | 🟡 | fila e sinalização verificadas; vídeo não testado sem intérprete conectado |
| App Android (Capacitor) | 🟡 | projeto nativo gerado e sincronizado (câmera, microfone, ML Kit); APK não compilado aqui por falta do Android SDK |

## Verificação feita

- 304 testes automatizados passando: 201 nas bibliotecas, no simulador e no Worker da Cloudflare e 103 da API (integração contra o Postgres, criptografia da assinatura e layout do BPA)
  contra PostgreSQL real.
- Teste de fumaça com Playwright (`e2e/smoke.e2e.mjs`) percorrendo 13 telas com 8 papéis no build de produção.
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
