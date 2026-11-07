# e-SUS APS: fichas (LEDI) e envio ao PEC

O OmniSaúde gera as fichas do e-SUS APS a partir do que já é registrado na unidade e as envia ao PEC
(Prontuário Eletrônico do Cidadão) do município, no padrão **LEDI 8.7.0** (Layout e-SUS APS de Dados e
Interface) em Apache Thrift (TBinaryProtocol), que é o formato aceito pelo PEC para sistemas de terceiros.

## O que vira ficha

| Ficha (TipoDadoSerializado) | Origem no sistema | Observações |
|---|---|---|
| Cadastro individual (2) | cidadãos criados/alterados no período, ligados à unidade (domicílio ou atendimento) | nome pelas regras do CADSUS, CNS/CPF, raça/cor, escolaridade, trabalho, parentesco e responsável, condições de saúde a partir dos CID ativos, situação de rua, óbito; sem família vinculada, o marcador de responsável familiar fica em branco (opcional no LEDI) |
| Cadastro domiciliar e territorial (3) | domicílios da unidade criados/alterados no período | endereço no padrão DNE (tipo de logradouro e UF por código), condições de moradia, famílias com responsável (CNS ou CPF) |
| Atendimento individual (4) | registros SOAP/evolução assinados em atendimentos encerrados | uma ficha por profissional e dia (até 99 atendimentos); CIAP2/CID10 avaliados, medições da classificação de risco, exames solicitados, conduta pelo desfecho do atendimento |
| Atendimento odontológico (5) | odontogramas assinados | conduta, vigilância em saúde bucal (99 quando não registrada) e procedimentos informados em `data.procedimentos` |
| Procedimentos (7) | classificações de risco / acolhimento | medições (PA, glicemia, temperatura, peso, altura) e totais consolidados por profissional e dia |
| Vacinação (14) | vacinas registradas pela API | imunobiológico, dose, lote, fabricante (código RNDS), via e local de aplicação; a tela de sala de vacina chega em APS-8 |

| Visita domiciliar e territorial (8) | visitas registradas no app do ACS e no app do ACE | uma ficha por agente, CBO e dia (até 99 visitas) com a lotação do próprio agente; pessoa (CNS/CPF ou justificativa), desfecho, motivos, microárea ou fora de área, tipo de imóvel, medições, posição (`docs/ACS.md`, `docs/ENDEMIAS.md`) |

Atividade coletiva (6) fica para os grupos (APS-7), que são a fonte desse registro.

## Fluxo na tela e-SUS APS

1. **Gerar lote** para uma unidade e um período: cada ficha passa pela validação prévia (regras do dicionário do
   LEDI: CNS pelo algoritmo, CPF ou justificativa, CBO aceita no modelo, nomes, datas, condutas, documento do
   responsável...). O que o PEC recusaria fica **inválida**, com o motivo, e não é enviado. Cada atendimento,
   procedimento, classificação de risco, vacina e visita vai a uma ficha só: o sistema guarda em que ficha foi cada
   registro (`esus_record_items`), e gerar de novo um período já enviado leva só o que faltou (se tudo já foi, o aviso
   diz "Todos os registros da unidade no período já foram exportados em lotes anteriores"). Dois lotes gerados ao
   mesmo tempo com os mesmos registros: um passa e o outro recebe 409. Se uma fonte falha na leitura, o lote sai com
   as demais e mostra o aviso "Fichas não geradas neste lote (falha ao ler ...)", que fica registrado na trilha; se
   nenhuma ficha sai por causa da falha, a resposta é 503 ("tente de novo").
2. **Enviar ao PEC** pela API de transmissão (`/api/recebimento/login` e `/api/v1/recebimento/ficha`, uma
   ficha por requisição, sessão por cookie). Recusas do PEC ficam registradas com a mensagem dele.
3. **Reprocessar**: regera cada ficha inválida ou recusada só com os registros dela, a partir dos dados atuais
   (depois de corrigir o cadastro, o atendimento ou a lotação), mantendo o mesmo identificador, também dentro do
   arquivo. O registro que não gera mais ficha, ou que mudou de dia ou de profissional, sai da ficha e fica livre para
   o próximo lote. O cadastro é reprocessado pela origem, mesmo fora do período. A resposta traz quantas fichas foram
   regeradas, quantas continuam inválidas, quantas não mudaram e quantos registros foram liberados.
4. **Baixar .zip**: um arquivo `.esus` por ficha, para importar no PEC em *Importar arquivos* quando a API não
   estiver habilitada.

Cadastros aceitos uma vez saem nas próximas vezes como **atualização** (`fichaAtualizada` com o uuid da ficha
original), como o LEDI exige: vão de novo quando mudam.

## Ficha de visita domiciliar e territorial

- **CBO do cabeçalho**: resolvido na exportação. Vale o CBO gravado na visita se o modelo o aceita; senão, o da
  lotação ativa do profissional na unidade, no papel da visita (ACS na visita do ACS; ACE ou supervisor de endemias
  na do ACE). Corrigir a lotação e reprocessar conserta a ficha.
- **INE**: o da equipe em que o profissional está com esse CBO; sem equipe com esse CBO, a ficha vai sem INE (o ACE
  sem equipe, mesmo sendo também ACS de uma eSF). Nas fichas de atendimento, procedimentos e vacina, o INE prefere a
  equipe com o CBO da lotação.
- **Pessoa, medições e motivos por tipo de imóvel** (LEDI 8.7.0), conferidos no lote e já na entrada do app do ACS:
  - domicílio (01): a visita realizada pede a pessoa, salvo nos motivos 27, 28 e 34 a 37;
  - abrigo, ILPI, unidade prisional, socioeducativa, delegacia e outros (07 a 11 e 99): a pessoa só é obrigatória
    com motivo de busca ativa (2, 3, 4, 30), acompanhamento (5 a 24, 32, 33, 38), 25 ou 31, ou com peso ou altura;
  - comércio, terreno baldio, ponto estratégico, escola, creche, estabelecimento religioso e CASAI (02 a 06, 12 e
    13): sem pessoa, sem medições e só os motivos 1, 27, 28, 31 e 34 a 37.
- **Volume**: as consultas por identificador vão em lotes de 5.000 e as fichas são gravadas de 500 em 500; o lote
  funciona acima de 32.767 domicílios trabalhados no período.

## Configuração

| Variável | Uso |
|---|---|
| `PEC_URL` | endereço da instalação do PEC (HTTPS, ex.: `https://pec.municipio.gov.br`) |
| `PEC_USUARIO`, `PEC_SENHA` | credencial de integração criada no PEC em *Integração > Credenciais de integração* (pessoa jurídica: razão social, CNPJ, e-mail) |

Por instituição, a linha `ESUS_PEC` em `tenant_integrations` aceita `url`, `usuario` e a senha por referência de
segredo. Sem configuração, a demonstração usa o simulador local (`MOCKS_URL`), que valida o transporte, lê a
ficha e responde como o PEC.

A identificação do remetente no transporte (`DadoInstalacao`) usa o CNPJ e o nome da instituição; a versão do
LEDI informada é 8.7.0 e `tpCdsOrigem` = 3 (sistemas terceiros).

## Requisitos no PEC do município

- O município precisa ter o PEC instalado com a **API de transmissão** ativa e o CNES, as equipes (INE) e os
  profissionais (CNS/CBO) cadastrados: o PEC só aceita fichas de CNES, INE e profissionais do próprio município.
- O CBO da lotação de quem gera o lote precisa ser aceito nos modelos de cadastro (se não for, o sistema usa a
  lotação de um profissional da unidade, de preferência da enfermagem).

## Como foi conferido

- Serialização comparada byte a byte com a implementação de referência do Apache Thrift e com o código gerado
  pelo compilador oficial a partir dos `.thrift` do repositório público do e-SUS (`laboratoriobridge/esusab-integracao`,
  11/09/2026).
- Dicionários e regras extraídos da documentação oficial do LEDI 8.7.0 (integracao.esusab.ufsc.br): tabelas de
  códigos em `packages/esus/src/codes.ts`, esquema em `packages/esus/src/ledi-schema.ts` (regerado por
  `scripts/gen-ledi-schema.mjs`).
- Pendente: receber um lote num PEC real (homologação do município). O simulador cobre o protocolo e as regras
  de transporte, não todas as validações de conteúdo do PEC.
