# App do cidadão (CID-1)

Entrega das semanas 19 e 20 do cronograma: o cidadão vê e cuida da própria saúde pelo celular, sem senha e sem
cadastro novo. Tudo o que aparece vem dos registros que a rede já mantém (agenda, prontuário, sala de vacina,
farmácia, regulação, TFD e fila da recepção). As telas vivem em `/cidadao` (mesmo site e mesmo pacote Android do
OmniSaúde), separadas da área dos profissionais: outra sessão, outro armazenamento e outro conjunto de rotas na API.

## Acesso

1. O cidadão informa **município/instituição, CPF e data de nascimento**.
2. Se o cadastro existir e tiver **WhatsApp autorizado** (consentimento registrado na recepção), recebe um **código
   de 6 dígitos** pelo WhatsApp (modelo `codigo_acesso`, categoria de autenticação), válido por 10 minutos.
   A resposta da API é a mesma quando o CPF não existe ou a data não bate: ninguém descobre quem está cadastrado.
3. Sem WhatsApp, a **recepção emite um código** na ficha do paciente (botão "Código do app"), válido por 24 horas e
   registrado na auditoria em nome de quem emitiu. Exige CPF no cadastro.
4. O código vale **uma vez**; cada código aceita até 5 tentativas erradas; no máximo 3 pedidos pelo WhatsApp a cada
   15 minutos. Confirmado, a sessão dura 12 horas (token com estágio `citizen`, assinado como os demais).

O token do cidadão abre **só** as rotas `/api/cidadao/*` (guard global: rotas marcadas com `@CitizenRoute()`), e
um token de profissional não as abre. Cadastros unificados em outro (`mergedIntoId`) não entram.

## O que o cidadão vê e faz

| Tela | Conteúdo | Ações |
|---|---|---|
| Início | nome, idade, CNS; senha do dia (posição na fila da recepção); próximo compromisso; resultados novos (30 dias), vacinas atrasadas e pedidos em andamento; unidade de referência (domicílio/família) | |
| Agenda | próximos e histórico de 12 meses, com serviço, profissional, unidade e endereço | **confirmar presença** (canal `APP`), **cancelar** até o horário (a vaga volta para a lista de espera, com o motivo registrado como "Cancelado pelo cidadão no app"), salvar no calendário do telefone (.ics), ligar/desligar **lembretes pelo WhatsApp** |
| Exames | exames solicitados e resultados liberados (valor, unidade e texto), com aviso de que só o profissional interpreta | |
| Vacinas | doses aplicadas (unidade, lote, transcrições) e **próximas doses** pelo Calendário Nacional, com atrasadas destacadas | baixar o **certificado** em PDF (versão sem assinatura digital, com rodapé explicando; a assinada é pedida na unidade) |
| Remédios | itens das **receitas ambulatoriais ativas** em linguagem simples (posologia e uso contínuo), última retirada, **onde há estoque** nas farmácias da rede; retiradas dos últimos 6 meses | |
| Fila | solicitações da regulação com **posição na fila** (mesmo tipo e especialidade, ordenada por prioridade e data), agendamento e devolutivas; vagas de leito; **TFD** com atendimento, viagem (veículo, motorista) e ajuda de custo | |
| Unidades | unidades ativas com tipo, endereço, horário, telefone e "como chegar" | |

A posição na fila usa a mesma regra da central de regulação (prioridade, depois antiguidade), portanto a tela do
cidadão e o painel do regulador mostram a mesma ordem.

## API

| Rota | Quem | Função |
|---|---|---|
| `POST /api/cidadao/acesso/solicitar` | pública | pede o código (resposta genérica) |
| `POST /api/cidadao/acesso/confirmar` | pública | confere o código e devolve o token do cidadão |
| `POST /api/cidadao/codigos` | `paciente.cadastrar` | código entregue pela recepção (24 h) |
| `GET /api/cidadao/eu` | cidadão | resumo e pendências |
| `GET /api/cidadao/agenda`, `POST .../agenda/:id/confirmar`, `POST .../agenda/:id/cancelar`, `PATCH .../preferencias` | cidadão | agenda, confirmação, cancelamento, lembretes |
| `GET /api/cidadao/exames`, `/vacinas`, `/vacinas/certificado.pdf`, `/medicamentos`, `/regulacao`, `/senha`, `/unidades` | cidadão | demais telas |

Modelo novo: `citizen_access_codes` (hash SHA-256 do código, canal, telefone, validade, uso, tentativas, quem
emitiu, IP). Migração `0017_app_cidadao`. Regras e rótulos compartilhados em `packages/shared/src/cidadao.ts`
(máscara de telefone, quem pode cancelar/confirmar, posologia, uso contínuo, código a partir de bytes aleatórios,
arquivo .ics).

## Privacidade (LGPD)

- CPF e telefone aparecem mascarados; o app nunca lista outras pessoas.
- O código é guardado só como hash; o uso fica em `citizen_access_codes.used_at` com IP.
- Ações do cidadão não passam pela trilha de auditoria dos profissionais (que exige usuário e papel); o
  cancelamento fica no próprio agendamento, com o motivo e a origem "app".
- A sessão fica no `localStorage` do aparelho (12 horas); "Sair" apaga.

## Demonstração

1. Entre como recepção (CPF 100.000.001-08) e abra a ficha de qualquer paciente com CPF: "Código do app".
2. Em outro navegador ou no celular, abra `/cidadao`, informe `demo`, o CPF e a data de nascimento.
   Com o WhatsApp simulado (`MOCKS_URL`), o código enviado aparece em `GET <mocks>/whatsapp/_sent`.

## Testes

- `apps/api/test/citizen-app.test.ts`: pedido e confirmação do código (resposta genérica, limite de tentativas,
  uso único, limite de pedidos), código da recepção, isolamento dos tokens, resumo, senha, agenda (confirmar,
  cancelar, agendamento de outra pessoa não aparece), lembretes, exames, vacinas/certificado, medicamentos,
  regulação com posição na fila.
- `packages/shared/test/cidadao.test.ts`: máscara, regras de cancelamento, posologia, código e .ics.

## Pendências

- Aprovação do modelo `codigo_acesso` na conta do WhatsApp Business do município (categoria *authentication*).
- CID-2 (semana 21): assistente com IA no WhatsApp.
- Notificações push nativas (o lembrete hoje é pelo WhatsApp e pelo calendário do telefone).
