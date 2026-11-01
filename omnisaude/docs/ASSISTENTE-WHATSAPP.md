# Assistente do cidadão no WhatsApp (CID-2)

Entrega da semana 21 do cronograma. O número de WhatsApp da instituição passa a responder mensagens do cidadão
24 horas por dia: dúvidas e orientação, consultas (ver, marcar, confirmar, cancelar, remarcar), exames, vacinas,
remédios, fila da regulação e TFD, senha do dia, unidades e horários, e triagem de sintomas com encaminhamento.
A equipe acompanha tudo na tela **Assistente WhatsApp** e assume a conversa quando o cidadão pede uma pessoa.

## Como funciona

1. **Entrada**: o webhook do WhatsApp (`/api/webhooks/whatsapp/:tenant`) já recebia botões de confirmação e
   remarcação. Agora toda mensagem de texto e os botões `ASSIST:*` vão para o `AssistantService`.
2. **Quem está falando**: o telefone é procurado nos cadastros com **WhatsApp autorizado** (consentimento
   registrado na recepção). Sem cadastro ou sem autorização, o assistente só dá informações gerais (unidades,
   horários, orientação sobre sintomas) e explica como autorizar. Quando o mesmo número está em mais de um
   cadastro (família), pergunta de quem se trata (botões) e lembra a escolha por 24 horas.
3. **Entendimento**: primeiro as **regras** (menu numérico 1 a 9 e palavras-chave, em
   `packages/ai-engine/src/assistant.ts`), que funcionam sem chave de IA. Com a IA ativada na instituição
   (`aiEnabled`) e chave configurada, o **modelo de linguagem** lê o texto livre com saída estruturada
   (intenção, gravidade, sinais, resposta curta, precisa de humano). Os **sinais de alerta** por regra (dor no
   peito, falta de ar, desmaio, convulsão, sangramento intenso, sinais de AVC, intoxicação, risco à própria vida,
   trabalho de parto, trauma grave, reação alérgica grave) prevalecem sempre: a resposta é a orientação de
   emergência (192 e UPA mais próxima), mesmo que o modelo diga outra coisa.
4. **Resposta**: tudo que é dado pessoal ou transação vem do sistema, nunca do modelo: a agenda, a oferta de
   horários (próximos horários livres das agendas da unidade de referência, médicos primeiro), a marcação
   (mesmas regras de cota e conflito da agenda; o profissional da agenda fica como responsável e a observação
   registra a origem), confirmação (canal `WHATSAPP`), cancelamento (vaga volta para a lista de espera),
   remarcação (mesma oferta de horários usada na confirmação 48 h), exames (nome e situação, **sem valores**),
   vacinas (doses e atrasadas), remédios (receitas ativas e onde há estoque), fila (posição) e TFD, senha do dia,
   unidades (filtradas pelo nome ou tipo citado). A resposta livre do modelo é usada só em dúvidas gerais e como
   complemento na triagem não emergencial.
5. **Pessoa da equipe**: "falar com atendente", emergência na triagem ou o modelo sinalizando que precisa de
   humano colocam a conversa em **Aguardando atendente** e avisam a tela em tempo real. A recepção, o serviço
   social ou o gestor respondem pela tela (a mensagem sai pelo mesmo número, em nome de quem respondeu, com
   auditoria) e podem encerrar a conversa.

Janela de silêncio: as respostas são a mensagens que o próprio cidadão acabou de enviar (janela de 24 horas da
Meta), por isso saem a qualquer hora. Lembretes e confirmações continuam respeitando 22h–06h.

## Configuração (plataforma, `PATCH /api/platform/tenants/:id`)

| Campo | Uso |
|---|---|
| `whatsappEnabled` | número conectado (já existia) |
| `assistantEnabled` | liga o assistente (padrão: desligado) |
| `assistantName` | nome com que se apresenta (padrão "Assistente de saúde"; a demonstração usa "Vida") |
| `assistantFaq` | lista de `{pergunta, resposta}` da instituição, usada pelo modelo nas respostas |
| `aiEnabled` + `ANTHROPIC_API_KEY` | leitura de texto livre pelo modelo; sem isso vale o menu e as palavras-chave |

## Tela da equipe (`/assistente`, permissões `assistente.ler` e `assistente.responder`)

Painel (conversas e mensagens em 7 dias, aguardando atendente, consultas marcadas por conversa em 30 dias,
triagens com emergência, modo com IA ou por regras), lista de conversas com filtro por situação e busca por nome
ou telefone, transcrição com a intenção reconhecida em cada mensagem, resposta humana e encerramento.

## Dados e privacidade

- `assistant_conversations` (telefone, cadastro, situação, contexto da conversa, última triagem, motivo do
  pedido de atendente) e `assistant_messages` (entrada/saída, texto, intenção, detalhes, autor humano).
  Migração `0018_assistente_whatsapp`; mensagens enviadas também ficam em `message_logs` (`ASSISTENTE`).
- Telefones aparecem mascarados na tela; o assistente nunca envia valores de exames nem dados de outra pessoa.
- Tudo o que o modelo recebe: unidades, FAQ, um resumo do cidadão identificado (nome, próxima consulta,
  contagens) e as últimas 6 mensagens. Com `aiEnabled` desligado nada sai para o provedor.

## Testes

- `packages/ai-engine/test/assistant.test.ts`: regras, sinais de alerta, orientação de triagem, menu, prompt e
  schema.
- `apps/api/test/assistant.test.ts`: número desconhecido (sem dados pessoais, unidades, emergência), cidadão
  identificado (menu, agenda, marcação por botões com cota da agenda, confirmação, cancelamento liberando a vaga,
  exames, vacinas, remédios, fila, senha), pedido de atendente com resposta pela tela e encerramento, painel,
  permissão negada ao médico, e o caminho com IA (modelo falso): resposta livre, sinal de alerta prevalecendo,
  intenção transacional respondida com dados e sinalização de humano.

## Demonstração

Com o simulador (`MOCKS_URL`), envie um POST ao webhook com uma mensagem de texto do telefone de um paciente com
WhatsApp autorizado e veja a resposta em `GET <mocks>/whatsapp/_sent`. A tela `/assistente` mostra a conversa.

## Pendências

- Em produção, cadastrar o webhook na conta do WhatsApp Business (`WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`).
- Áudio e imagens recebidos são ignorados (respondemos pedindo texto); transcrição de áudio pode vir depois.
- CID-3/CID-4 (semana 22): ouvidoria, pesquisa de satisfação e compatibilidade com o Meu SUS Digital.
