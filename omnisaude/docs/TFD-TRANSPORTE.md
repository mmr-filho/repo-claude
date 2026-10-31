# TFD e transporte sanitário (REG-5 e REG-6)

Duas telas fecham o acesso ao tratamento fora do município: **TFD** (`/tfd`) cuida do processo de Tratamento
Fora do Domicílio da Portaria SAS/MS 55/1999 (laudo médico, envio à regional ou ao estado, parecer, agendamento
no destino, ajuda de custo para paciente e acompanhante, impressão); **Transporte sanitário** (`/transporte`)
cuida da frota, dos motoristas, das rotas recorrentes, das viagens com passageiros, do roteiro do dia e dos
registros de manutenção e abastecimento. As duas se encontram na **reserva de transporte**: um processo de TFD
deferido reserva lugar (e o do acompanhante) numa viagem planejada, e o roteiro do motorista mostra quem
embarca, onde e para qual atendimento.

## Papéis e permissões

| Permissão | Quem tem | O que faz |
|---|---|---|
| `tfd.ler` | recepção, enfermagem, médico, serviço social, NIR, gestão | acompanha os processos (a própria unidade; quem tem `tfd.gerir` vê a rede toda), painel, PDFs |
| `tfd.gerir` | médico, serviço social, NIR, gestão | abre e edita laudo, envia, registra parecer, agenda, lança e paga ajuda de custo, reserva transporte, conclui e cancela |
| `transporte.ler` | recepção, enfermagem, serviço social, NIR, gestão | frota, motoristas, rotas, viagens, roteiro do dia e indicadores |
| `transporte.gerir` | NIR e gestão | cadastra veículos, motoristas e rotas; cria, inicia, conclui e cancela viagens; inclui passageiros e registra embarque/falta; manutenção e abastecimento |

Quem tem `tfd.gerir` também pode incluir passageiros numa viagem (é o que a reserva de transporte do TFD faz).

## TFD: o processo

```
ABERTO ──enviar──▶ ENVIADO ──parecer──▶ DEFERIDO ──agendar──▶ AGENDADO ──concluir──▶ CONCLUIDO
   │                               └──▶ INDEFERIDO (laudo pode ser corrigido e o processo reaberto)
   └──────────────── cancelar (qualquer situação em andamento) ──────────────▶ CANCELADO
```

1. **Laudo** (médico): diagnóstico e CID-10, procedimento (nome e SIGTAP opcional), resumo clínico, justificativa
   de indisponibilidade no município, caráter de urgência, destino (cidade, UF, IBGE, unidade), transporte
   (rodoviário, aéreo, ambulância, veículo sanitário, próprio), pernoite e acompanhante (nome, CPF, vínculo).
   O processo recebe número `TFD-AAAA-NNNNNN` e só pode existir **um em andamento por pessoa**. O laudo pode ser
   corrigido enquanto o processo está aberto ou indeferido.
2. **Envio** à regional ou ao estado (serviço social, NIR): registra a data e a observação (SEI, ofício, malote).
3. **Parecer**: deferido ou indeferido, com o texto do parecer, se a **ajuda de custo foi aprovada** e o
   transporte autorizado (pode mudar o pedido do laudo). Indeferido encerra o processo; o cidadão recebe a
   devolutiva por WhatsApp (mesmo modelo aprovado da regulação, `regulacao_atualizacao`).
4. **Agendamento no destino**: data, hora e local; pode ser reagendado. Devolutiva por WhatsApp.
5. **Ajuda de custo** (só com aprovação no parecer): itens por beneficiário (paciente ou acompanhante, este só se
   o laudo o previu) com tipo (passagem, diária, alimentação, hospedagem, outro), quantidade e valor unitário.
   O total é calculado em `totalAjudaCusto`; o pagamento é marcado em separado e entra no painel (12 meses).
6. **Transporte**: lista as viagens planejadas a partir de hoje com lugares livres; a reserva ocupa um lugar para
   o paciente e outro para o acompanhante, herda data e local do atendimento e o endereço de embarque do cadastro.
   A reserva pode ser cancelada e refeita; cancelar o processo cancela a reserva.
7. **Conclusão** após o tratamento; **mensagens** ficam no histórico com quem registrou.

Cada mudança gera um evento (`TfdEvent`) com usuário, papel e observação, auditoria e aviso em tempo real
(`tfd.atualizado`) para a unidade solicitante. A linha do tempo do paciente mostra os processos como eventos
**TFD**. Dois PDFs saem do processo: o **laudo** (modelo da Portaria 55, com identificação, diagnóstico,
procedimento, justificativa, destino, transporte, acompanhante e parecer) e a **guia de viagem** (atendimento,
transporte reservado, embarque, ajuda de custo por beneficiário e orientações).

## Transporte sanitário

- **Frota**: placa (única), modelo, tipo (ambulância básica, UTI, van, micro-ônibus, ônibus, carro; cada tipo
  tem um número padrão de lugares), lugares, acessibilidade a cadeirante, odômetro e próxima manutenção (km ou
  data). A tela mostra consumo médio (km/l dos abastecimentos), km, custo e viagens dos últimos 30 dias.
- **Registros do veículo**: manutenção (com próxima prevista) e abastecimento (litros obrigatórios). Atualizam o
  odômetro e alimentam os indicadores.
- **Motoristas**: nome, CPF, telefone, CNH (número, categoria, validade). CNH vencida impede a viagem; a vencer em
  30 dias gera alerta. Os alertas da frota (manutenção vencida ou próxima, CNH) aparecem no topo da tela.
- **Rotas**: viagem recorrente com destino, dias da semana, saída e retorno, veículo padrão e pontos de embarque
  (nome, endereço, horário). A viagem do dia nasce da rota (herda destino, horário e veículo) ou é avulsa.
- **Viagens**: `PLANEJADA → EM_ANDAMENTO → CONCLUIDA` ou `CANCELADA`. O mesmo veículo não sai duas vezes no
  mesmo dia e horário. Iniciar registra o odômetro de saída; concluir registra o de chegada (vira km rodados no
  veículo), o abastecimento (vira registro) e marca como **embarcados** os passageiros ainda agendados.
- **Passageiros**: pessoa do cadastro, acompanhante (ocupa lugar), endereço de embarque (padrão: cadastro),
  atendimento (data, hora e local), cadeirante (exige veículo acessível), vínculo com TFD ou com solicitação
  da regulação. Situação: agendado, embarcou, faltou, cancelado. Lotação e acessibilidade são verificadas na
  inclusão (`ocupacaoViagem`).
- **Roteiro do dia**: viagens não canceladas da data, com veículo, motorista e telefone, lugares, e os
  passageiros não cancelados na ordem de embarque, com endereço e atendimento. É a folha do motorista.
- **Indicadores** do período (viagens concluídas): por veículo, viagens, km, passageiros embarcados, faltas,
  combustível, manutenção e custo por km; totais e custo por passageiro.

## API

| Rota | Permissão | Uso |
|---|---|---|
| `GET /api/tfd/processos?status&patientId&unitId&escopo` · `GET /api/tfd/painel` | `tfd.ler` | lista (escopo `central` para quem gere) e painel por situação |
| `POST /api/tfd/processos` · `PUT /api/tfd/processos/:id/laudo` | `tfd.gerir` | abre e corrige o laudo |
| `POST …/:id/enviar` · `…/parecer` · `…/agendar` · `…/concluir` · `…/cancelar` · `…/mensagem` | `tfd.gerir` | transições e mensagens |
| `PUT …/:id/ajuda-custo` · `POST …/:id/ajuda-custo/pagar` | `tfd.gerir` | ajuda de custo e pagamento |
| `POST …/:id/viagem` · `POST …/:id/viagem/cancelar` | `tfd.gerir` | reserva e cancela transporte |
| `GET …/:id` · `GET …/:id/laudo.pdf` · `GET …/:id/guia.pdf` | `tfd.ler` | detalhe com histórico e PDFs |
| `GET/POST /api/transporte/veiculos` · `PATCH …/:id` · `GET/POST …/:id/registros` | `transporte.ler` / `transporte.gerir` | frota e registros |
| `GET/POST/PATCH /api/transporte/motoristas` · `…/rotas` | idem | motoristas e rotas |
| `GET/POST /api/transporte/viagens` · `GET …/:id` · `POST …/:id/iniciar` · `…/concluir` · `…/cancelar` | idem | viagens |
| `POST /api/transporte/viagens/:id/passageiros` | `transporte.gerir` ou `tfd.gerir` | inclui passageiro |
| `POST /api/transporte/passageiros/:id/status` | `transporte.gerir` | embarcou, faltou, cancelado |
| `GET /api/transporte/roteiro?date` · `GET /api/transporte/indicadores?from&to` | `transporte.ler` | roteiro do dia e indicadores |

## Regras em código compartilhado (`packages/shared/src/tfd.ts`)

`STATUS_TFD`, `TRANSPORTE_TFD`, `TIPO_AJUDA_CUSTO`, `totalAjudaCusto`, `numeroProcessoTfd`, `TIPO_VEICULO`
(com lugares padrão), `STATUS_VIAGEM`, `STATUS_PASSAGEIRO`, `TIPO_REGISTRO_VEICULO`, `ocupacaoViagem`,
`consumoMedio` e `alertasFrota` são usados pela API e pelo web e têm testes próprios.

## Dados de demonstração

Van QKA2B34 (acessível, 48.200 km, revisão aos 50.000) e ambulância QKB5C67; motoristas Raimundo (CNH em dia) e
Eliane (CNH vence em 20 dias, gera alerta); rota "Gurupi → Palmas" às segundas, quartas e sextas, 04:30, com
três pontos de embarque; abastecimentos e uma revisão; uma viagem concluída e uma planejada para daqui a dois
dias com Maria Aparecida (TFD `TFD-AAAA-000001` deferido e agendado, ajuda de custo de duas diárias, com
acompanhante) e José Carlos (cadeirante).

## Pontos de atenção

- O envio à regional é **registrado**, não transmitido: cada estado tem o seu fluxo (SEI, sistema próprio, papel).
- A ajuda de custo segue os valores definidos pelo município ou estado; o sistema calcula e registra o pagamento,
  mas não integra com o financeiro.
- O WhatsApp usa o mesmo modelo `regulacao_atualizacao` já aprovado; mensagens fora da janela de silêncio ficam
  adiadas, como nas demais devolutivas.
- A geolocalização do roteiro (ordem ótima de embarque) não está no escopo: a ordem é a de inclusão, com os
  pontos da rota como referência.
