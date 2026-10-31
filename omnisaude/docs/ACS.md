# App do ACS (APS-3)

A tela **Agente de saúde** (`/acs`) é o trabalho de campo do agente comunitário de saúde: o território da
sua microárea, o registro de visitas domiciliares e territoriais, o cadastro domiciliar e individual na porta
da casa e o mapa. Tudo funciona **sem internet**: os registros ficam no aparelho e são enviados quando a
conexão volta. A mesma tela, no papel de enfermagem ou gestão, mostra o território por equipe/microárea e a
**produtividade** dos agentes. No Android, é a mesma tela empacotada pelo Capacitor (`apps/mobile`).

## Papel e permissões

- Papel **ACS** (`Agente Comunitário de Saúde`), sugerido automaticamente pelo CBO 5151xx na importação do
  CNES e nas lotações. Permissões: `acs.campo` (registrar visitas e cadastros em campo, sincronizar),
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

Efeitos de uma visita realizada: atualiza a posição do domicílio quando ele não tinha, marca a última visita
dos casos de busca ativa abertos da pessoa e entra nos indicadores e programas (abaixo).

### No aparelho

- A fila fica no **IndexedDB** (`apps/web/src/lib/acs-store.ts`): registros pendentes e com erro, com a
  mensagem. A sincronização roda ao registrar (com rede), ao voltar a conexão e pelo botão **Sincronizar**.
- O território, as visitas e a produtividade ficam em cache; sem rede a tela mostra a cópia e a data.
- A sessão (`/auth/me`) também fica guardada para a tela abrir sem rede; um 401 do servidor encerra a sessão.
- Um **service worker** (`public/sw.js`) guarda os arquivos das telas (fora do app nativo, que já é local).
  A API nunca passa por ele.
- Domicílios e pessoas cadastrados sem rede aparecem no território marcados como "aguardando envio" e já
  podem receber visitas (a referência é resolvida na sincronização).

## Mapa

Leaflet com OpenStreetMap: um ponto por domicílio com posição, verde (visitado em 30 dias), âmbar (até 90
dias) ou vermelho (sem visita recente). A posição é marcada pelo GPS do aparelho ao cadastrar o domicílio ou
ao registrar a visita. Sem internet o fundo do mapa não carrega, mas os pontos continuam.

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
