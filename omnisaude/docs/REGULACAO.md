# Regulação ambulatorial (REG-1 e REG-2)

A tela **Regulação** (`/regulacao`) e a aba **Encaminhamentos** do atendimento cobrem o acesso regulado à
atenção especializada: a solicitação nasce no atendimento, passa pelo protocolo de encaminhamento da
especialidade, recebe uma classificação de prioridade e entra numa **fila única** por procedimento, onde o
regulador autoriza, devolve com pendência ou nega, com **devolutiva** ao solicitante (na hora) e ao cidadão
(WhatsApp). Agendamento regulado, cotas e prestadores chegam em REG-3/REG-4.

## Papéis e permissões

| Permissão | Quem tem | O que faz |
|---|---|---|
| `regulacao.solicitar` | médico, enfermagem, equipe multiprofissional, NIR | cria solicitações, complementa devoluções, cancela as da própria unidade |
| `regulacao.ler` | os anteriores, recepção, serviço social, gestão | acompanha as solicitações da unidade, o painel e os protocolos |
| `regulacao.regular` | NIR e gestão | fila única, análise, autorização, devolução, negativa, mensagens |

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
   pessoa é recusada (409). O número de protocolo é `REG-AAAA-NNNNNN`.
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

Situações: `PENDENTE`, `EM_ANALISE`, `DEVOLVIDA`, `AUTORIZADA`, `AGENDADA`, `NEGADA`, `CANCELADA`, `REALIZADA`
(as duas últimas de REG-4 ficam reservadas).

## Dados

`regulation_requests` (solicitação, com prioridade pedida e vigente, critérios, pendências do protocolo,
regulador, decisão, unidade executante), `regulation_events` (histórico: mudanças de situação e mensagens, com
quem e quando) e `regulation_attachments` (documentos do paciente anexados). Tudo auditado
(`regulacao.solicitar`, `regulacao.analisar`, `regulacao.autorizar`, `regulacao.devolver`, `regulacao.negar`,
`regulacao.complementar`, `regulacao.cancelar`, `regulacao.mensagem`, `regulacao.visualizar`).

## Demonstração

A carga tem quatro solicitações da UBS Centro (cardiologia pendente com pendência de exame, oftalmologia
autorizada para a Policlínica, endocrinologia devolvida, mamografia eletiva há 40 dias) e o NIR Fábio Teixeira
lotado também na Policlínica Municipal como regulador.

## Testes

- `packages/shared/test/regulacao.test.ts`: protocolos, prioridade sugerida, verificação, ordem da fila,
  prazos e permissões.
- `packages/messaging/test/regulacao-template.test.ts`: modelo da devolutiva por WhatsApp.
- `apps/api/test/regulation.test.ts`: verificação, solicitação com protocolo, duplicidade, fila única por
  prioridade, análise, devolução e complementação (volta à posição original), autorização com reclassificação
  e devolutiva por WhatsApp no simulador, negativa, cancelamento, painel e linha do tempo.

## Próximos passos (REG-3/REG-4)

PPI e cotas por prestador, contratos, **agendamento regulado** (o regulador agenda na agenda do executante,
com confirmação e remarcação pelo WhatsApp já existentes), tempo médio de fila por prestador; depois TFD e
transporte sanitário (REG-5/6) e a integração com a RNDS e o e-SUS Regulação (INT-5).
