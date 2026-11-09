# App do ACS (APS-3)

A tela **Agente de saúde** (`/acs`) é o trabalho de campo do agente comunitário de saúde: o território da
sua microárea, o registro de visitas domiciliares e territoriais, o cadastro domiciliar e individual na porta
da casa e o mapa. Tudo funciona **sem internet**: os registros ficam no aparelho e são enviados quando a
conexão volta. A mesma tela, no papel de enfermagem ou gestão, mostra o território por equipe/microárea e a
**produtividade** dos agentes. No Android, é a mesma tela empacotada pelo Capacitor (`apps/mobile`).

## Papel e permissões

- Papel **ACS** (`Agente Comunitário de Saúde`), sugerido automaticamente pelo CBO 5151xx (menos o 515140, do
  agente de combate às endemias, que sugere o papel ACE; ver `docs/ENDEMIAS.md`) na importação do CNES e nas lotações. Permissões: `acs.campo` (registrar visitas e cadastros em campo, sincronizar),
  `acs.territorio`, `paciente.ler`/`paciente.cadastrar`, `vacinas.ler` e `aps.programas`. O agente **não**
  acessa o prontuário clínico.
- Enfermagem e gestão têm `acs.territorio`: veem o território e a produtividade, mas não registram em campo.
- O território do agente vem do vínculo na equipe (_Administração › Equipes_: membro com CBO de ACS e
  microárea). Sem vínculo, a tela orienta a pedir a lotação.

## Território

`GET /api/acs/territorio` devolve os domicílios da equipe/microárea com famílias, pessoas (idade, parentesco,
telefone, **prioridades**: gestante, criança menor de 2 anos, pessoa idosa, hipertensão, diabetes,
tuberculose/hanseníase, Bolsa Família) e a **última visita** do domicílio e de cada pessoa. O resumo traz
domicílios, pessoas, visitados em 30 dias, sem visita há 90 dias e as prioridades.

## Visitas, cadastros e sincronização

Tudo o que o agente registra vira uma **operação de campo** (`OperacaoCampo` em
`packages/shared/src/acs.ts`) com um `clientId` gerado no aparelho:

| Operação    | O que faz no servidor                                                                                                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PESSOA`    | cadastro individual mínimo (nome, nascimento, sexo, CPF/CNS, mãe, telefone, raça/cor, escolaridade, NIS, Bolsa Família) pelo `PatientsService`; entra na família informada com o parentesco                                                                         |
| `DOMICILIO` | cadastro domiciliar (endereço, condições de moradia, posição) pelo `HouseholdsService`, com a família e o responsável (já cadastrado ou cadastrado na mesma ida); atualização quando traz `householdId`                                                             |
| `VISITA`    | visita domiciliar/territorial: pessoa (ou só o imóvel), desfecho (realizada, recusada, ausente), motivos (códigos da ficha do e-SUS), turno, compartilhada, fora de área, tipo de imóvel, medições (peso, altura, PA, temperatura, glicemia), posição e observações |

`POST /api/acs/sync` recebe até 500 operações, ordena (pessoas, domicílios, visitas) e aplica uma a uma. A
resposta diz, por `clientId`, se ficou **OK**, **DUPLICADA** (já tinha sido aplicada numa sincronização
anterior; devolve o mesmo id) ou **ERRO** (regra de negócio, p. ex. possível duplicidade de cadastro ou
visita realizada a domicílio sem a pessoa). Referências entre operações do mesmo lote usam o `clientId`
(`familiaClientId`, `responsavelClientId`, `householdClientId`, `patientClientId`). Cada operação aplicada é
registrada em `field_sync_ops` (idempotência e rastreio); as visitas ficam em `home_visits`.

A visita segue as regras do LEDI 8.7.0 por tipo de imóvel, no app (antes de entrar na fila) e na sincronização:
no domicílio (01), a visita realizada pede a pessoa; em abrigo, ILPI, unidade prisional, socioeducativa, delegacia e
outros (07 a 11 e 99), a pessoa só é pedida com motivo de busca ativa ou acompanhamento, 25, 31, peso ou altura; em
comércio, terreno baldio, ponto estratégico, escola, creche, estabelecimento religioso e CASAI (02 a 06, 12 e 13),
não há pessoa nem medições e só valem os motivos 1, 27, 28, 31 e 34 a 37 (o app desabilita os demais). A
sincronização recusa o que foge disso com `PESSOA_FORA_DO_DOMICILIO`, `MEDICAO_FORA_DO_DOMICILIO`,
`MOTIVO_FORA_DO_DOMICILIO` ou `PESSOA_OBRIGATORIA`.

Efeitos de uma visita realizada: atualiza a posição do domicílio quando ele não tinha (e, se um morador tem caso
numa ordem de bloqueio de transmissão, o caso é reavaliado na hora: `docs/ENDEMIAS.md`), marca a última visita dos
casos de busca ativa abertos da pessoa e entra nos indicadores e programas (abaixo).

### No aparelho

- A fila fica no **IndexedDB** (`apps/web/src/lib/acs-store.ts`, banco `omnisaude-campo`, separado do banco do
  app do ACE): registros pendentes e com erro, com a mensagem. O formulário fecha assim que o registro está guardado,
  e a sincronização roda em segundo plano ao registrar (com rede), ao voltar a conexão e pelo botão **Sincronizar**; o
  registro guardado durante um envio vai na rodada seguinte.
- O registro com mais de uma operação (domicílio novo com o responsável novo) entra na fila numa transação só do banco
  do aparelho: todas as operações ou nenhuma, mesmo se a aba fechar no meio, e nenhum envio, desta aba ou de outra, vê
  parte dele. Duas abas não mandam a fila ao mesmo tempo (trava do navegador entre abas; sem ela, em navegador antigo ou
  fora de HTTPS, a ordem dos envios vale só por aba). O registro descartado durante o envio não volta para a fila com o
  erro do servidor.
- Se o aparelho não consegue gravar, o formulário mostra o motivo e continua aberto: nada é dado como registrado.
  Outra aba prendendo o banco e as falhas gerais dão "Não foi possível guardar no aparelho: feche as outras abas do
  OmniSaúde e tente de novo"; a falta de espaço, "...o espaço de armazenamento acabou. Libere espaço e tente de novo",
  também quando a falha vem na gravação e não na confirmação. O registro é tudo ou nada também quando uma operação não
  pode ser guardada na hora: a transação é cancelada. Uma falha do aparelho durante o envio, depois de o registro estar guardado, aparece como aviso ("O
  envio parou... Nada se perde: o que ficou na fila vai no próximo envio, sem duplicar") e não volta ao formulário
  (salvar de novo duplicaria a visita); a falha ao descartar ou ao tentar de novo também vira aviso.
- Marcar o erro do servidor e "tentar de novo" leem e regravam o item numa transação só: o descarte feito noutra aba
  nesse meio-tempo vale, e o item não volta.
- A hora de cada item da fila é a do relógio do aparelho; os itens de um registro ficam na ordem das operações. O item
  só vai para depois do último quando o relógio voltou até 1 s; se voltou mais (acerto pela hora da rede), fica com a
  hora do relógio.
- O território, as visitas e a produtividade ficam em cache; sem rede a tela mostra a cópia e a data.
- A sessão (`/auth/me`) também fica guardada para a tela abrir sem rede; um 401 do servidor encerra a sessão.
- Um **service worker** (`public/sw.js`), registrado em todas as telas autenticadas do build de produção, guarda
  as telas de campo do ACS e do ACE e os arquivos delas (fora do app nativo, que já é local). A API nunca passa por
  ele.
- Domicílios e pessoas cadastrados sem rede aparecem no território marcados como "aguardando envio" e já
  podem receber visitas (a referência é resolvida na sincronização).

## Mapa

Leaflet com OpenStreetMap: um ponto por domicílio com posição, verde (visitado em 30 dias), âmbar (até 90
dias) ou vermelho (sem visita recente). A posição é marcada pelo GPS do aparelho ao cadastrar o domicílio ou
ao registrar a visita; na visita, o domicílio que já tem quarteirão (o escolhido pelo ACE em campo) só recebe a
posição quando ela cai nesse quarteirão. Sem internet o fundo do mapa não carrega, mas os pontos continuam.

## Produtividade

`GET /api/acs/produtividade?teamId&unitId&from&to`: por agente, visitas por desfecho, domicílios e pessoas
distintas visitadas, **cobertura** (domicílios do território visitados no período), cadastros feitos em campo,
motivos mais frequentes e última sincronização. O agente vê só a própria.

## Integrações

- **e-SUS APS**: as visitas geram a **ficha de visita domiciliar e territorial** (tipo 8 do LEDI), uma por
  agente e dia (até 99 visitas), com a lotação do próprio agente (CNS, CBO 5151xx, INE), validação prévia
  (`checkVisitaDomiciliar`) e envio ao PEC como as demais fichas (`docs/ESUS.md`).
- **Indicadores da APS**: as visitas realizadas por ACS/TACS alimentam as boas práticas de visita (C2-D,
  C3-E e J, C4-D, C5-D, C6-C), que deixaram de ser "sem fonte" (`docs/INDICADORES-APS.md`).
- **Programas**: pré-natal, puericultura, HAS/DM e pessoa idosa passam a cobrar as visitas do ACS nas faltas
  e na busca ativa (`docs/PROGRAMAS-APS.md`).

## Demonstração

Agente **Joaquim Pereira Agente Comunitário** (CPF 100.000.011-71, senha padrão), lotado na UBS Centro como
ACS e membro da ESF Centro I, microárea 01; os domicílios da carga têm coordenadas em Gurupi/TO e duas visitas
registradas.

## Testes

- `packages/shared/test/acs.test.ts`: motivos, turno, permissões, ordem das operações e produtividade.
- `packages/esus/test/fichas.test.ts`: montagem, validação e Thrift da ficha de visita.
- `apps/api/test/acs.test.ts`: território, sincronização idempotente com referências entre operações, erros
  de negócio, ficha de visita no lote do e-SUS aceita pelo PEC simulado, produtividade e efeito nos programas.

## Fora do escopo desta entrega

- Rotas otimizadas e cadastro de imóveis para endemias (VIG-3 reaproveita o app).
- Edição de pessoa já cadastrada em campo (a operação `PESSOA` com `patientId` existe na API; a tela traz só
  a inclusão) e exclusão de registros já sincronizados.
