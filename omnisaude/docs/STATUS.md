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
| Assinatura ICP-Brasil (A1/A3/nuvem) | ⏳ | preferência por tenant já existe; falta o conector (assinatura CMS/PAdES e validação) |

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
| BPA-I e BPA-C | 🟡 | layout reconstruído: validar com o documento oficial do DATASUS antes de enviar |
| Laudo APAC e lote AIH | ⏳ | há o espelho de AIH; geração dos arquivos pendente |
| RNDS: RAC, imunização, dispensação, sumário de alta (FHIR + mTLS) | 🟡 | implementado e testado contra o mock; perfis e códigos precisam ser conferidos com o guia vigente da RNDS e com o credenciamento |
| Consulta CADSUS | ✅ | |
| Integração com a central de vagas (SISREG) | ⏳ | só o código de regulação na internação; o SISREG não tem API pública |

## Front-end (web e Android)

| Tela | Status | Observação |
|---|---|---|
| Login em etapas, troca de unidade/papel, menu por permissão | ✅ | |
| Administração: unidades, profissionais e lotações, senha provisória, 2FA obrigatório por papel | ✅ | NUC-6 do roadmap; cadastro pela tela sem depender da carga de demonstração; desativar vale na hora |
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

- 277 testes automatizados passando: 196 nas bibliotecas e no Worker da Cloudflare e 81 de integração da API
  contra PostgreSQL real.
- Teste de fumaça com Playwright (`e2e/smoke.e2e.mjs`) percorrendo 13 telas com 8 papéis no build de produção.
- Fluxo de administração no navegador: a gestora cadastra uma unidade e um profissional, recebe a senha
  provisória, o profissional entra, só vê "Minha conta" até trocar a senha e depois acessa a Recepção.
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
