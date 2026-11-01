# Ouvidoria, pesquisa de satisfação e Meu SUS Digital (CID-3 e CID-4)

Entrega da semana 22 do cronograma.

## Ouvidoria (CID-3)

Manifestação do cidadão sobre os serviços de saúde, nos termos da **Lei 13.460/2017** (defesa do usuário de
serviços públicos): reclamação, denúncia, sugestão, elogio, solicitação ou pedido de informação.

| Regra | Como está |
|---|---|
| Protocolo | `OUV-AAAA-NNNNNN`, gerado na hora em qualquer canal |
| Prazo | 30 dias para a resposta conclusiva (art. 16), prorrogável **uma única vez** por mais 30 dias, com justificativa registrada e aviso ao cidadão, e só enquanto o prazo ainda corre (prazo vencido não se prorroga: responde-se). Vencida assim que passa da data; em alerta nos 5 dias anteriores |
| Identificação | opcional: a manifestação anônima guarda o cadastro e o telefone só para o próprio cidadão acompanhar e receber a resposta; a equipe não vê nome nem contato e não a encontra pela busca por nome. No WhatsApp, basta o cidadão pedir ("denúncia anônima", "não quero me identificar"): a conversa vista na tela do assistente guarda só um aviso, sem o conteúdo nem o protocolo |
| Canais | app do cidadão (`/cidadao/ouvidoria`); WhatsApp (o assistente reconhece reclamação, denúncia, elogio e sugestão, registra com o texto e devolve o protocolo; se a mensagem só anuncia — "quero fazer uma reclamação" — pede os detalhes e registra a próxima mensagem, em até 30 minutos; número sem cadastro registra identificado pelo telefone, para a resposta chegar; sintomas que pedem atendimento no dia recebem a orientação de urgência junto com o protocolo e avisam a equipe); balcão, telefone e site (tela da equipe) |
| Tramitação | recebida → em análise (encaminhada a uma unidade e responsável) → prazo prorrogado → respondida → encerrada; arquivamento só com motivo. Cada mudança só vale se a manifestação ainda estiver no estado em que a pessoa a viu (duas pessoas agindo ao mesmo tempo não se sobrescrevem). Registros simultâneos recebem protocolos distintos; o ano do protocolo segue o fuso da instituição |
| Resposta | vai para o app do cidadão e, com WhatsApp autorizado, chega pelo modelo `ouvidoria_resposta` (janela de silêncio respeitada) |
| Avaliação | o cidadão avalia a resposta de 1 a 5 com comentário, também depois que a equipe encerra; a nota aparece na manifestação e no painel |
| Painel | abertas, no prazo, vencendo em 5 dias, vencidas, respondidas nos últimos 30 dias e quantas no prazo, tempo médio de resposta, distribuição por tipo, assunto e unidade (30 dias), avaliação média. A lista filtra por situação, prazo, tipo, unidade e busca (protocolo, texto, nome do paciente ou do contato), direto no banco |
| Auditoria | ações da equipe (registro no balcão, encaminhamento, prorrogação, resposta, encerramento e arquivamento) ficam na trilha de auditoria com o autor. Registros feitos pelo próprio cidadão (app e WhatsApp) e a avaliação da resposta ficam na linha do tempo da manifestação, com o canal e a data |

Permissões: `ouvidoria.ler` e `ouvidoria.registrar` (recepção, serviço social, gestor) e `ouvidoria.gerir` (serviço
social e gestor: encaminhar, prorrogar, responder, encerrar, arquivar e ver o resultado da satisfação por
profissional).

Tela: **Ouvidoria** (`/ouvidoria`), abas *Manifestações* e *Pesquisa de satisfação*.

## Pesquisa de satisfação (CID-3)

- Criada automaticamente ao **encerrar o atendimento** com alta ou encaminhamento (não em óbito, evasão ou
  internação), vinculada à unidade e ao profissional que assinou o registro clínico. Na unificação de cadastros,
  pesquisas e manifestações do duplicado passam para o cadastro que fica.
- **WhatsApp** (quando o assistente está ligado, porque é ele que lê os botões; senão a pesquisa fica só no app):
  modelo `pesquisa_satisfacao` ("Como foi o seu atendimento de consulta do dia 31/10 na UBS Centro?") com três
  botões, Ótimo (5), Regular (3) e Ruim (2), enviado 2 horas depois, fora da janela de silêncio. A nota entra na
  hora; a mensagem seguinte, em até 30 minutos, vira comentário, a não ser que seja uma reclamação ou denúncia (aí
  vai para a ouvidoria com protocolo) ou outro pedido (que encerra a janela). Respondida no app antes do envio, a
  mensagem agendada é cancelada.
- **App do cidadão** (`/cidadao/avaliar`): nota de 1 a 5, "recomendaria de 0 a 10" (NPS) e comentário; a pesquisa
  fica disponível por 7 dias e também aparece como destaque no início do app.
- Painel (`/ouvidoria`, aba Pesquisa de satisfação): pesquisas e respostas por canal, taxa de resposta, nota média,
  NPS, distribuição das notas, por unidade e, para quem gere a ouvidoria, por profissional; total de comentários e os
  20 mais recentes.

## Compatibilidade com o Meu SUS Digital (CID-4)

O **Meu SUS Digital** (app do Ministério da Saúde, ex-Conecte SUS Cidadão) mostra ao cidadão, com a conta
gov.br, o que chegou à RNDS no seu CPF: vacinas, atendimentos, resultados de exames, medicamentos dispensados e
internações. A compatibilidade do OmniSaúde é, portanto, **enviar os registros à RNDS com o CPF correto**:

- Documentos já enviados pelo OmniSaúde: atendimento (RAC), imunização (RIA), dispensação (RDM), sumário de alta
  e regulação assistencial (RIRA). Todos usam CPF e CNS do cidadão nos identificadores (`docs/RNDS.md`).
- **Prontidão por pessoa**: CPF válido (é por ele que o app identifica a pessoa), CNS e RNDS ativa na instituição.
  O que falta aparece como pendência para a recepção resolver.
- Situação dos envios: enviados, na fila, com erro temporário (nova tentativa automática) e recusados de vez (dado
  faltando ou rejeição da RNDS, que pedem correção).
- Onde ver: ficha do paciente (cartão *Meu SUS Digital*, `GET /api/patients/:id/meu-sus-digital`) e início do
  app do cidadão (cartão com os registros enviados e link para o app do Ministério, `GET /api/cidadao/meu-sus-digital`).
- O que não depende de nós: o tempo de processamento da RNDS e a versão do app; o resultado de exames aparece
  quando o laboratório envia o REL (fora do escopo atual).

## Dados

`ombudsman_cases`, `ombudsman_events`, `satisfaction_surveys` (migração `0019_ouvidoria_satisfacao`); regras em
`packages/shared/src/ouvidoria.ts` (protocolo, prazo, situação do prazo, inferência de tipo e assunto, NPS e
resumo); modelos de WhatsApp em `packages/messaging/src/templates.ts`.

## Testes

- `packages/shared/test/ouvidoria.test.ts`: protocolo, prazo, situação (inclusive no primeiro dia após o vencimento),
  faixas de prazo para o banco, inferência de tipo e assunto, pedido de anonimato, mensagem só de abertura, NPS e resumo.
- `apps/api/test/ombudsman.test.ts`: registro presencial com prazo de 30 dias e permissões; manifestação anônima
  pelo app (identidade oculta, busca por nome não encontra); encaminhar, prorrogar uma única vez, responder com
  aviso por WhatsApp, avaliar e painel; reclamação pelo WhatsApp com protocolo; pesquisa criada no encerramento do
  atendimento, modelo com botões, resposta por botão com comentário e pelo app com NPS, painel por unidade e por
  profissional; Meu SUS Digital com prontidão e contagem após o envio à RNDS. Correções da revisão: serviço social
  gere a ouvidoria; prazo vencido filtra no banco e não aceita prorrogação; avaliação depois de encerrada; busca por
  unidade e texto juntas e pelo nome do contato; cinco registros simultâneos com protocolos distintos; anonimato
  pedido no WhatsApp sem rastro na conversa; número desconhecido identificado pelo telefone; abertura curta seguida
  dos detalhes; urgência com orientação; reclamação depois do botão da pesquisa vira manifestação; janela do
  comentário expira e é encerrada por outro pedido; pesquisa só após alta ou encaminhamento; sem assistente, só no
  app; resposta no app cancela o WhatsApp agendado; unificação de cadastros leva manifestações e pesquisas.

## Pendências

- Aprovação dos modelos `ouvidoria_resposta` e `pesquisa_satisfacao` na conta do WhatsApp Business.
- Relatório periódico da ouvidoria (exportação) e integração com o Fala.BR, se o município aderir.
