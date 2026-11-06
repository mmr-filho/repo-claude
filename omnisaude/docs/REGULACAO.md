# Regulação ambulatorial (REG-1 a REG-4)

A tela **Regulação** (`/regulacao`) e a aba **Encaminhamentos** do atendimento cobrem o acesso regulado à
atenção especializada: a solicitação nasce no atendimento, passa pelo protocolo de encaminhamento da
especialidade, recebe uma classificação de prioridade e entra numa **fila única** por procedimento, onde o
regulador autoriza, devolve com pendência ou nega, com **devolutiva** ao solicitante (na hora) e ao cidadão
(WhatsApp). Em REG-3/REG-4 entram os **prestadores** (rede própria e contratados, com tetos), a **PPI e as
cotas** por competência, o **agendamento regulado** na agenda do executante (com a confirmação e a remarcação
pelo WhatsApp já existentes), o registro de falta, a conclusão e os tempos médios de fila.

## Papéis e permissões

| Permissão | Quem tem | O que faz |
|---|---|---|
| `regulacao.solicitar` | médico, enfermagem, equipe multiprofissional, NIR | cria solicitações, complementa devoluções, cancela as da própria unidade |
| `regulacao.ler` | os anteriores, recepção, serviço social, gestão | acompanha as solicitações da unidade, o painel e os protocolos |
| `regulacao.regular` | NIR e gestão | fila única, análise, autorização (com prestador e cota), devolução, negativa, mensagens; prestadores e cotas; agendamento regulado |
| `agenda.marcar` na unidade executante | recepção da unidade | agenda, remarca, desmarca, registra falta e conclui as solicitações autorizadas para a sua unidade |

## Protocolos de encaminhamento

`packages/shared/src/regulacao.ts` traz, em código compartilhado, 13 especialidades (cardiologia,
endocrinologia, nefrologia, neurologia, oftalmologia, ortopedia, otorrinolaringologia, psiquiatria,
dermatologia, ginecologia, urologia, gastroenterologia, pneumologia) e 10 exames/procedimentos regulados
(mamografia, ultrassonografias, ecocardiograma, endoscopia, colonoscopia, tomografia, teste ergométrico,
densitometria, cirurgia de catarata). Cada protocolo tem:

- **critérios de encaminhamento**, cada um com a prioridade sugerida (base: Protocolos de Encaminhamento da
  Atenção Básica para a Atenção Especializada, MS/TelessaúdeRS-UFRGS; INCA para a mamografia; CAB 32 para a
  ultrassonografia obstétrica);
- **exames mínimos** (obrigatórios e recomendados), reconhecidos no prontuário pelo código SIGTAP ou pelo
  analito nos últimos 12 meses;
- o que **segue na atenção primária** sem encaminhar.

Os protocolos apoiam a decisão; não substituem a avaliação clínica. A aba *Protocolos* da tela mostra todos.

## Prioridade e prazo-meta

| Prioridade | Prazo-meta | Justificativa |
|---|---|---|
| Vermelha (emergência) | 1 dia | obrigatória |
| Amarela (urgência) | 7 dias | obrigatória |
| Verde (prioridade) | 30 dias | — |
| Azul (eletivo) | 90 dias | — |

A prioridade é sugerida pelo critério mais grave marcado e pode ser alterada pelo solicitante (com
justificativa nas duas primeiras) e **reclassificada pelo regulador** ao autorizar; a pedida fica registrada.

## Fluxo

1. **Solicitar** (aba Encaminhamentos do atendimento ou `POST /api/regulacao/solicitacoes`): tipo, especialidade
   ou exame, critérios, prioridade, CID, quadro clínico (pré-preenchido com a avaliação e o plano do SOAP) e
   anexos (documentos do paciente). A verificação do protocolo (`POST /api/regulacao/verificar`) mostra, antes
   de enviar, os exames mínimos sem resultado, a falta de critério e a falta de justificativa; as pendências
   ficam gravadas na solicitação para o regulador. Uma solicitação aberta da mesma especialidade para a mesma
   pessoa é recusada (409). O número de protocolo é `REG-AAAA-NNNNNN`; solicitações simultâneas recebem números
   distintos e o ano segue o fuso da instituição.
2. **Fila única** (`GET /api/regulacao/fila`): pendentes e em análise, ordenadas por prioridade e, dentro dela,
   por ordem de chegada; posição, dias na fila, prazo-meta e atraso; totais por prioridade e por especialidade;
   espera média. Filtros por especialidade, prioridade e tipo.
3. **Decisão** do regulador: *assumir análise*, **autorizar** (reclassificação opcional, unidade executante,
   orientações), **devolver** com pendência ou **negar** com motivo. Quem solicitou **complementa** a devolução
   (texto, anexos, prioridade) e a solicitação volta à fila **na posição original** (mantém a data). Qualquer
   lado registra **mensagens** no histórico. Cancelamento pela unidade solicitante ou pela regulação.
4. **Devolutiva**: cada mudança emite `regulacao.atualizada` para a unidade solicitante (a tela atualiza em
   tempo real) e fica no histórico; para o cidadão com WhatsApp autorizado, as decisões de autorização,
   negativa, agendamento e cancelamento geram a mensagem `regulacao_atualizacao` (modelo UTILITY, enviado pelo
   job de mensagens, respeitando a janela de silêncio). A linha do tempo do paciente mostra a solicitação.

Situações: `PENDENTE`, `EM_ANALISE`, `DEVOLVIDA`, `AUTORIZADA`, `AGENDADA`, `NEGADA`, `CANCELADA`, `REALIZADA`.

## Prestadores, contratos, PPI e cotas (REG-3)

Aba **Prestadores e cotas** da tela Regulação (`/api/regulacao/prestadores`). Um prestador é uma unidade da
rede própria (ligado a uma unidade do sistema, onde ficam as agendas) ou um serviço contratado, filantrópico
ou de consórcio, com CNES/CNPJ, contrato (número e vigência) e **tetos mensais** físico (procedimentos) e
financeiro (R$). As **cotas** são definidas por competência (AAAA-MM), tipo e especialidade ou procedimento,
com quantidade e valor unitário; uma cota pode ser **reservada a uma unidade solicitante** (PPI por origem).

Na autorização o regulador escolhe o prestador (`GET /api/regulacao/ofertas` mostra, para a especialidade,
quem tem vaga na competência e quem não tem cota configurada, caso em que não há limite). A autorização
**consome a cota** (primeiro a reservada à unidade solicitante, depois a geral) e confere os tetos do
contrato; cota esgotada ou teto atingido recusam com `COTA_ESGOTADA`, `TETO_FISICO` ou `TETO_FINANCEIRO`.
Cancelamentos devolvem a vaga. Cotas com uso não podem ser removidas, só reduzidas.

## Agendamento regulado, confirmação e remarcação (REG-4)

Com a solicitação **autorizada** para um prestador da rede própria, a regulação (ou a recepção da unidade
executante) escolhe a agenda (`GET /api/regulacao/prestadores/:id/agendas`, com os próximos horários livres)
e o horário (grade da agenda, `GET /api/scheduling/schedules/:id/slots`) e **agenda**
(`POST /api/regulacao/solicitacoes/:id/agendar`). O agendamento é o mesmo da agenda da unidade (cotas de
primeira consulta, bloqueios, um horário por pessoa por dia) e dispara a **confirmação de presença pelo
WhatsApp** 48 h antes, com os botões de confirmar, cancelar e remarcar. A solicitação passa a `AGENDADA`,
guarda a data e avisa o cidadão.

Depois disso: **remarcar** (`/remarcar`, novo horário na mesma agenda), **desmarcar** (`/desmarcar`, a vaga
volta à agenda e a solicitação volta a autorizada), **falta** (`/falta`, só após o horário; conta o não
comparecimento e volta a autorizada para reagendar) e **concluir** (`/realizar`). O que acontece na agenda
sem passar pela regulação (chegada do paciente, falta registrada pela recepção, cancelamento ou remarcação
pelo WhatsApp) é refletido na solicitação quando ela é lida (`AGENDADA` → `REALIZADA`, falta ou volta a
autorizada; remarcação troca o agendamento vinculado).

**Tempos médios** (últimos 90 dias) no painel da regulação: da solicitação à decisão e ao agendamento, no
total e por prestador (autorizadas, agendadas, realizadas, faltas).

## Dados

`regulation_requests` (solicitação, com prioridade pedida e vigente, critérios, pendências do protocolo,
regulador, decisão, prestador, cota e competência da autorização, agendamento vinculado e faltas),
`regulation_events` (histórico: mudanças de situação e mensagens, com quem e quando),
`regulation_attachments` (documentos do paciente anexados), `regulation_providers` (prestadores e contratos)
e `regulation_quotas` (PPI e cotas). Tudo auditado (`regulacao.solicitar`, `regulacao.analisar`,
`regulacao.autorizar`, `regulacao.devolver`, `regulacao.negar`, `regulacao.complementar`,
`regulacao.cancelar`, `regulacao.mensagem`, `regulacao.visualizar`, `regulacao.agendar`,
`regulacao.remarcar`, `regulacao.desmarcar`, `regulacao.falta`, `regulacao.realizar`,
`regulacao.prestador.*`, `regulacao.cotas.definir`).

## Demonstração

A carga tem quatro solicitações da UBS Centro (cardiologia pendente com pendência de exame, oftalmologia
autorizada para a Policlínica com cota consumida, endocrinologia devolvida, mamografia eletiva há 40 dias), o
NIR Fábio Teixeira lotado também na Policlínica Municipal como regulador, dois prestadores (Policlínica
Municipal, rede própria, com cotas de cardiologia, oftalmologia e endocrinologia e uma reserva de PPI para a
UBS Centro; Clínica Conveniada Imagem, contratada, com tetos e cotas de mamografia, ultrassonografia e
ecocardiograma) e as agendas de cardiologia e oftalmologia na Policlínica.

## Testes

- `packages/shared/test/regulacao.test.ts`: protocolos, prioridade sugerida, verificação, ordem da fila,
  prazos e permissões.
- `packages/messaging/test/regulacao-template.test.ts`: modelo da devolutiva por WhatsApp.
- `apps/api/test/regulation.test.ts`: verificação, solicitação com protocolo, duplicidade, fila única por
  prioridade, análise, devolução e complementação (volta à posição original), autorização com reclassificação
  e devolutiva por WhatsApp no simulador, negativa, cancelamento, painel e linha do tempo; cinco solicitações
  simultâneas com protocolos distintos.
- `apps/api/test/regulation-providers.test.ts`: prestadores e cotas (cadastro, PPI, consumo, cota esgotada,
  teto financeiro, cota com uso), agendamento regulado na agenda do prestador (vaga ocupada recusada,
  remarcação, desmarcação, falta antes da hora recusada, conclusão) e tempos médios por prestador.

## Próximos passos

TFD e transporte sanitário (REG-5/REG-6), regulação de leitos e AIH (REG-7) e a integração com a RNDS
(Portaria 6.656/2025) está em `docs/RNDS.md`, seção 6 (aba **Envio à RNDS** desta tela); o e-SUS Regulação não tem API pública e é conciliado pelo código externo da solicitação (INT-5). Prestadores externos sem agenda no sistema recebem a
autorização e o agendamento é registrado manualmente (data informada ao cidadão pela unidade).
