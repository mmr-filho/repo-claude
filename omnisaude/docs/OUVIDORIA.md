# Ouvidoria, pesquisa de satisfação e Meu SUS Digital (CID-3 e CID-4)

Entrega da semana 22 do cronograma.

## Ouvidoria (CID-3)

Manifestação do cidadão sobre os serviços de saúde, nos termos da **Lei 13.460/2017** (defesa do usuário de
serviços públicos): reclamação, denúncia, sugestão, elogio, solicitação ou pedido de informação.

| Regra | Como está |
|---|---|
| Protocolo | `OUV-AAAA-NNNNNN`, gerado na hora em qualquer canal |
| Prazo | 30 dias para a resposta conclusiva (art. 16), prorrogável **uma única vez** por mais 30 dias, com justificativa registrada e aviso ao cidadão |
| Identificação | opcional: a manifestação anônima guarda o cadastro só para o próprio cidadão acompanhar; a equipe não vê nome, contato nem encontra pela busca por nome |
| Canais | app do cidadão (`/cidadao/ouvidoria`), WhatsApp (o assistente reconhece reclamação, denúncia, elogio e sugestão, registra com o texto da mensagem e devolve o protocolo), balcão, telefone e site (tela da equipe) |
| Tramitação | recebida → em análise (encaminhada a uma unidade e responsável) → prazo prorrogado → respondida → encerrada; arquivamento só com motivo |
| Resposta | vai para o app do cidadão e, com WhatsApp autorizado, chega pelo modelo `ouvidoria_resposta` (janela de silêncio respeitada) |
| Avaliação | o cidadão avalia a resposta de 1 a 5 com comentário; a nota aparece na manifestação e no painel |
| Painel | abertas, no prazo, vencendo em 5 dias, vencidas, respondidas no mês e no prazo, tempo médio de resposta, por tipo, assunto e unidade, avaliação média |
| Auditoria | registro, encaminhamento, prorrogação, resposta, encerramento e arquivamento ficam na trilha de auditoria com o autor |

Permissões: `ouvidoria.ler` (recepção, serviço social, gestor), `ouvidoria.registrar` (recepção, serviço social,
gestor) e `ouvidoria.gerir` (serviço social e gestor: encaminhar, prorrogar, responder, encerrar, arquivar e ver o
resultado da satisfação por profissional).

Tela: **Ouvidoria** (`/ouvidoria`), abas *Manifestações* e *Pesquisa de satisfação*.

## Pesquisa de satisfação (CID-3)

- Criada automaticamente ao **encerrar o atendimento** com alta ou encaminhamento (não em óbito, evasão ou
  internação), vinculada à unidade e ao profissional que assinou o registro clínico.
- **WhatsApp**: modelo `pesquisa_satisfacao` com três botões (Ótimo, Regular, Ruim), enviado 2 horas depois,
  fora da janela de silêncio; a nota entra na hora e a mensagem seguinte do cidadão vira comentário.
- **App do cidadão** (`/cidadao/avaliar`): nota de 1 a 5, "recomendaria de 0 a 10" (NPS) e comentário; a pesquisa
  fica disponível por 7 dias e também aparece como destaque no início do app.
- Painel (`/ouvidoria`, aba Pesquisa de satisfação): pesquisas e respostas por canal, taxa de resposta, nota média,
  NPS, distribuição das notas, por unidade e, para quem gere a ouvidoria, por profissional; comentários recentes.

## Compatibilidade com o Meu SUS Digital (CID-4)

O **Meu SUS Digital** (app do Ministério da Saúde, ex-Conecte SUS Cidadão) mostra ao cidadão, com a conta
gov.br, o que chegou à RNDS no seu CPF: vacinas, atendimentos, resultados de exames, medicamentos dispensados e
internações. A compatibilidade do OmniSaúde é, portanto, **enviar os registros à RNDS com o CPF correto**:

- Documentos já enviados pelo OmniSaúde: atendimento (RAC), imunização (RIA), dispensação (RDM), sumário de alta
  e regulação assistencial (RIRA). Todos usam CPF e CNS do cidadão nos identificadores (`docs/RNDS.md`).
- **Prontidão por pessoa**: CPF válido (é por ele que o app identifica a pessoa), CNS e RNDS ativa na instituição.
  O que falta aparece como pendência para a recepção resolver.
- Onde ver: ficha do paciente (cartão *Meu SUS Digital*, `GET /api/patients/:id/meu-sus-digital`) e início do
  app do cidadão (cartão com os registros enviados e link para o app do Ministério, `GET /api/cidadao/meu-sus-digital`).
- O que não depende de nós: o tempo de processamento da RNDS e a versão do app; o resultado de exames aparece
  quando o laboratório envia o REL (fora do escopo atual).

## Dados

`ombudsman_cases`, `ombudsman_events`, `satisfaction_surveys` (migração `0019_ouvidoria_satisfacao`); regras em
`packages/shared/src/ouvidoria.ts` (protocolo, prazo, situação do prazo, inferência de tipo e assunto, NPS e
resumo); modelos de WhatsApp em `packages/messaging/src/templates.ts`.

## Testes

- `packages/shared/test/ouvidoria.test.ts`: protocolo, prazo, situação, inferência, NPS e resumo.
- `apps/api/test/ombudsman.test.ts`: registro presencial com prazo de 30 dias e permissões; manifestação anônima
  pelo app (identidade oculta, busca por nome não encontra); encaminhar, prorrogar uma única vez, responder com
  aviso por WhatsApp, avaliar e painel; reclamação pelo WhatsApp com protocolo; pesquisa criada no encerramento do
  atendimento, modelo com botões, resposta por botão com comentário e pelo app com NPS, painel por unidade e por
  profissional; Meu SUS Digital com prontidão e contagem após o envio à RNDS.

## Pendências

- Aprovação dos modelos `ouvidoria_resposta` e `pesquisa_satisfacao` na conta do WhatsApp Business.
- Relatório periódico da ouvidoria (exportação) e integração com o Fala.BR, se o município aderir.
