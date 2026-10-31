# Central de leitos da rede e AIH (REG-7)

A tela **Central de leitos** (`/central-leitos`) regula o acesso aos leitos de todos os hospitais e UPAs da rede:
a unidade de origem (UPA, UBS, hospital sem o serviço) pede a vaga a partir do atendimento ou da própria
central, o **médico regulador** avalia na fila por prioridade (com segunda avaliação quando quiser), autoriza
a vaga num destino e pode **reservar o leito**, a origem registra a **transferência** e o destino **interna** no
leito reservado, fechando a solicitação. A **AIH** (laudo para solicitação/autorização de internação
hospitalar) nasce da internação ou da solicitação de vaga, é autorizada com o número da faixa do gestor e
alimenta o espelho de faturamento. O censo de cada hospital (`/leitos`) passa a mostrar o leito
**reservado** e quem vem ocupá-lo.

## Papéis e permissões

| Permissão | Quem tem | O que faz |
|---|---|---|
| `leitos_rede.solicitar` | médico, NIR, gestão | solicita a vaga, complementa devoluções, registra a transferência, cancela e troca mensagens nas solicitações da própria unidade |
| `leitos_rede.ler` | os anteriores, enfermagem, serviço social | acompanha as solicitações da unidade (origem ou destino), o mapa da rede e o painel |
| `leitos_rede.regular` | NIR e gestão | fila da central, análise, devolução, segunda avaliação, autorização com destino e reserva de leito, negativa, internação em qualquer destino |
| `leitos.gerir` na unidade de destino | NIR do hospital | interna o paciente no leito reservado (pela central ou pelo censo) |
| `aih.solicitar` | médico, NIR, gestão | emite e corrige o laudo de AIH, cancela laudos pendentes |
| `aih.autorizar` | NIR e gestão | autoriza (faixa ou número manual), nega, cancela AIH autorizada, cadastra as faixas numéricas |
| `aih.ler` | os anteriores e faturamento | consulta os laudos, o painel e os PDFs |

## Solicitação de vaga

```
PENDENTE ──analisar──▶ EM_ANALISE ──autorizar──▶ AUTORIZADA ──transferir──▶ EM_TRANSFERENCIA ──internar──▶ INTERNADA
    ▲                       │ devolver                  │ (destino também pode internar direto)
    └──complementar── DEVOLVIDA                          └──negar/cancelar──▶ NEGADA / CANCELADA
```

- **Conteúdo**: tipo de leito (clínica médica, cirúrgica, UTI adulto/pediátrica, pediatria, obstetrícia,
  observação), especialidade, CID, quadro clínico, **sinais vitais** (PA, FC, FR, SatO2, temperatura, nível de
  consciência, oxigênio), **suporte** em uso (ventilação mecânica, droga vasoativa, oxigênio, diálise),
  isolamento e se é eletiva. Uma solicitação em andamento por pessoa.
- **NEWS2** (Royal College of Physicians, 2017, escala 1 de SpO2) é calculado dos sinais vitais e mostrado com a
  faixa de risco; a **prioridade sugerida** vem do NEWS2, do suporte e do tipo de leito (`prioridadeLeitoSugerida`):
  ventilação, droga vasoativa, UTI ou NEWS2 ≥ 7 → **emergência** (2 h); NEWS2 5–6, oxigênio ou diálise →
  **urgência** (6 h); demais → **prioritária** (24 h); eletiva estável → **eletiva** (72 h). O solicitante pode
  escolher outra; o regulador e a segunda avaliação podem reclassificar (a prioridade pedida fica guardada).
- **Fila da central**: pendentes e em análise, por prioridade e tempo de espera, com prazo-meta e marcação de
  atraso; filtro por tipo de leito. Atualiza em tempo real para toda a rede (`leitos_rede.fila`).
- **Devolução** com pendência (exames, estabilização): a origem complementa e volta à fila mantendo a data.
- **Segunda avaliação**: o regulador pede; outro regulador registra o parecer (não pode ser o mesmo usuário) e
  pode reclassificar. A decisão continua liberada para qualquer regulador.
- **Autorização**: hospital/UPA de destino (do mapa, com vagos por tipo), tipo de leito, **leito reservado**
  (opcional; só leitos vagos da unidade, compatíveis com o isolamento), transporte sugerido e reclassificação.
  A reserva muda o leito para **RESERVADO** no censo, com o nome, a origem e o protocolo; o leito reservado não
  pode ser bloqueado nem ocupado por outra pessoa. Reautorizar troca a reserva; negar ou cancelar a libera.
- **Transferência**: a origem (ou a central) registra transporte (ambulância avançada/básica, veículo
  sanitário, próprios), horário e observações.
- **Internação**: o destino interna pela central (botão **Internar**, leito reservado ou outro vago do tipo
  autorizado) ou pelo censo (`/leitos`, botão **Internar** no leito reservado, com o paciente já preenchido).
  A internação usa o fluxo normal do censo (`modules/beds`), guarda o protocolo como código de regulação,
  encerra a solicitação e avisa a origem.
- **Ficha em PDF** da solicitação/transferência (quadro clínico, sinais vitais, NEWS2, decisão, destino e
  transporte) para acompanhar o paciente.
- **Mapa da rede**: hospitais e UPAs com ocupação, vagos/ocupados/reservados por tipo de leito e quantos
  pacientes estão a caminho; atalho para o censo da unidade.
- **Painel**: fila, devolvidas, autorizadas, internadas e horas médias até a decisão e até a internação (30 dias).
- A linha do tempo do paciente mostra as solicitações como eventos **Vaga de leito**.

## AIH

- **Laudo** (médico, a partir do leito ocupado no censo, da solicitação de vaga ou da central): procedimento
  SIGTAP (busca por código ou nome; o nome oficial prevalece), CID principal, secundário e de causas
  associadas, **especialidade do leito** (01 cirurgia … 08 reabilitação) e **caráter** (01 eletivo, 02 urgência,
  03–06 acidentes e lesões), sinais e sintomas, condições que justificam a internação e provas diagnósticas.
  Um laudo pendente por pessoa; uma internação tem um laudo vigente.
- **Autorização**: o número de 13 dígitos é montado como UF (2) + ano (2) + tipo (1: principal, 5: longa
  permanência) + sequencial (7) + **dígito verificador** (módulo 11, pesos 2 a 9 da direita para a esquerda).
  O sequencial vem da **faixa numérica** cadastrada (do gestor; por unidade ou geral; com controle de
  concorrência e esgotamento) ou é digitado e conferido. Validade padrão de 30 dias. O número vai para a
  internação (`admission.aihNumber`) e aparece no **espelho de AIH** do faturamento.
- **Negativa** e **cancelamento** (laudo pendente por quem emitiu; AIH autorizada só pelo autorizador, limpando o
  número da internação). **PDF** do laudo no modelo do SIH/SUS. Painel com pendentes, autorizadas no mês e
  números disponíveis.
- A geração do **lote de AIH** (SISAIH01) para o SIH/SUS continua fora do escopo (FAT-2).

## API

| Rota | Permissão | Uso |
|---|---|---|
| `GET /api/regulacao-leitos/mapa` · `GET …/painel` | `leitos_rede.ler` | mapa da rede e painel |
| `GET /api/regulacao-leitos/fila?bedKind&priority` | `leitos_rede.regular` | fila da central ordenada |
| `GET /api/regulacao-leitos/solicitacoes?status&patientId&unitId&escopo` · `GET …/:id` · `GET …/:id/ficha.pdf` | `leitos_rede.ler` | lista (unidade ou central), detalhe com histórico, ficha |
| `POST /api/regulacao-leitos/solicitacoes` · `PUT …/:id` | `leitos_rede.solicitar` | solicita; complementa/atualiza |
| `POST …/:id/analisar` · `…/devolver` · `…/segunda-avaliacao/pedir` · `…/segunda-avaliacao` · `…/autorizar` · `…/negar` | `leitos_rede.regular` | regulação |
| `POST …/:id/transferir` · `…/cancelar` · `…/mensagem` | `leitos_rede.solicitar` ou `regular` | origem e central |
| `POST …/:id/internar` | `leitos.gerir` (destino) ou `leitos_rede.regular` | interna no leito (reservado ou outro) |
| `POST /api/admissions` com `bedRequestId` | `leitos.gerir` | internação pelo censo num leito reservado |
| `GET /api/aih/laudos?status&patientId&admissionId&escopo` · `GET …/:id` · `GET …/:id/laudo.pdf` · `GET /api/aih/painel` | `aih.ler` | laudos, detalhe, PDF, painel |
| `POST /api/aih/laudos` · `PUT …/:id` · `GET /api/aih/sigtap?q` | `aih.solicitar` | laudo e busca SIGTAP |
| `POST …/:id/autorizar` · `…/negar` · `…/cancelar` | `aih.autorizar` (cancelar também `aih.solicitar` se pendente) | decisão |
| `GET/POST /api/aih/faixas` · `PATCH …/:id` | `aih.autorizar` | faixas numéricas |

## Regras em código compartilhado (`packages/shared/src/leitos.ts`)

`TIPO_LEITO`, `PRIORIDADE_LEITO` (prazo em horas), `STATUS_SOLICITACAO_LEITO`, `TRANSPORTE_TRANSFERENCIA`,
`news2`, `prioridadeLeitoSugerida`, `ordenarFilaLeitos`, `prazoMetaLeito`, `horasEmFila`,
`numeroProtocoloLeito`, `ESPECIALIDADE_AIH`, `CARATER_INTERNACAO`, `TIPO_AIH`, `CODIGO_UF`, `dvAih`,
`numeroAih`, `validarNumeroAih`, `validadeAih`, com testes próprios.

## Dados de demonstração

Solicitação **LEI-AAAA-000001** de José Carlos (UPA, IAM trombolisado, UTI adulto, emergência, NEWS2 10)
aguardando a central; **LEI-AAAA-000002** de Antônia (UBS Centro, descompensação diabética) autorizada para a
clínica médica do Hospital Municipal com o leito **CM-04 reservado**; faixa de AIH do hospital
(TO, ano corrente, sequenciais 1000001–1000500) e laudo de AIH pendente para a internação de Francisco (CM-03).

## Pontos de atenção

- Não há integração com o SISREG hospitalar nem com centrais estaduais (CROSS e similares): a central é a do
  município/consórcio, e o código de regulação externo continua podendo ser digitado na internação.
- O dígito verificador do número da AIH segue o módulo 11 descrito acima; a faixa numérica válida é a que o
  gestor distribuir. Se o SIH local recusar um número, confira a faixa cadastrada antes de reemitir.
- O NEWS2 é apoio à decisão do solicitante e do regulador, não substitui a avaliação clínica; parâmetros
  faltantes aparecem como "faltam".
