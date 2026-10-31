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

| Visita domiciliar e territorial (8) | visitas registradas no app do ACS | uma ficha por agente e dia (até 99 visitas) com a lotação do próprio agente; pessoa (CNS/CPF ou justificativa), desfecho, motivos, microárea ou fora de área, tipo de imóvel, medições, posição (`docs/ACS.md`) |

Atividade coletiva (6) fica para os grupos (APS-7), que são a fonte desse registro.

## Fluxo na tela e-SUS APS

1. **Gerar lote** para uma unidade e um período: cada ficha passa pela validação prévia (regras do dicionário do
   LEDI: CNS pelo algoritmo, CPF ou justificativa, CBO aceita no modelo, nomes, datas, condutas, documento do
   responsável...). O que o PEC recusaria fica **inválida**, com o motivo, e não é enviado.
2. **Enviar ao PEC** pela API de transmissão (`/api/recebimento/login` e `/api/v1/recebimento/ficha`, uma
   ficha por requisição, sessão por cookie). Recusas do PEC ficam registradas com a mensagem dele.
3. **Reprocessar**: regera as fichas inválidas e recusadas a partir dos registros atuais (depois de corrigir o
   cadastro ou o atendimento) mantendo o mesmo identificador, para novo envio.
4. **Baixar .zip**: um arquivo `.esus` por ficha, para importar no PEC em *Importar arquivos* quando a API não
   estiver habilitada.

Cadastros aceitos uma vez saem nas próximas vezes como **atualização** (`fichaAtualizada` com o uuid da ficha
original), como o LEDI exige.

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
