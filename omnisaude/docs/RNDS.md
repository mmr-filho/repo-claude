# RNDS: credenciamento, configuração e perfis

A RNDS (Rede Nacional de Dados em Saúde) recebe do OmniSaúde o registro de atendimento clínico (RAC), o
registro de imunobiológico administrado, a dispensação de medicamento e o sumário de alta, em FHIR R4, com
autenticação pelo certificado digital do estabelecimento. Este documento junta o que foi conferido nas fontes
oficiais (guia de integração em rnds-guia.saude.gov.br, coleção oficial de requisições do DATASUS e pacote de
perfis publicado no Simplifier) e o que a gestão precisa fazer.

## 1. Credenciamento (quem faz: a gestão)

1. **Certificado digital** do estabelecimento ou do ente (e-CNPJ ICP-Brasil, tipo A1, arquivo `.pfx` com senha).
   É ele que autentica o conector na RNDS. Guarde o `.pfx` no R2 (`RNDS_CERT_PFX=r2:<chave>`) e a senha como
   segredo (`RNDS_CERT_PASSPHRASE`).
2. **Conta gov.br** do gestor responsável.
3. No [Portal de Serviços do DATASUS](https://servicos-datasus.saude.gov.br/), solicitar o **acesso à RNDS em
   homologação**: CNES do estabelecimento, certificado (parte pública, `.cer`), faixa de IPs públicos de saída e
   dados do responsável.
4. O DATASUS devolve o **identificador do solicitante**; ele entra no identificador dos documentos
   (`Bundle.identifier.system = http://www.saude.gov.br/fhir/r4/NamingSystem/BRRNDS-<identificador>`).
5. Com a homologação aprovada (documentos aceitos e evidências enviadas), solicitar o **acesso à produção**.

Atenção aos IPs de saída: na publicação 100% Cloudflare, o container da API não tem IP fixo de saída. Para o
credenciamento, informe a faixa de IPs da Cloudflare ou publique a API num ambiente com IP fixo (ver
`docs/PUBLICACAO.md`); o DATASUS confirma no momento da solicitação quais faixas aceita.

## 2. Endereços oficiais

| Ambiente | Autenticação (token) | Serviços FHIR (EHR) |
|---|---|---|
| Homologação | `https://ehr-auth-hmg.saude.gov.br` | `https://ehr-services.hmg.saude.gov.br` |
| Produção | `https://ehr-auth.saude.gov.br` | `https://<uf>-ehr-services.saude.gov.br` (um por estado, ex.: `to-ehr-services.saude.gov.br`) |

- Token: `GET {auth}/api/token` com o certificado cliente (mTLS). Resposta: `access_token`, `token_type: "jwt"`,
  `scope: "read write"`, `expires_in` (30 minutos). O sistema reaproveita o token até vencer.
- Toda chamada ao EHR leva dois cabeçalhos: `X-Authorization-Server: Bearer <token>` e `Authorization: <CNS do
  profissional em nome de quem a requisição é feita, lotado no estabelecimento>`.
- Envio de documentos: `POST {ehr}/api/fhir/r4/Bundle` com `Content-Type: application/fhir+json`; o id atribuído
  volta no cabeçalho `Location`.
- Consultas usadas pelo sistema: `GET /api/fhir/r4/Organization/<cnes>` (teste de conexão) e
  `GET /api/fhir/r4/Patient?identifier=http://rnds.saude.gov.br/fhir/r4/NamingSystem/cpf|<cpf>` (CADSUS).

## 3. Configuração no OmniSaúde

Variáveis de ambiente (segredos do Worker/container) ou, por instituição, a linha `RNDS` em
`tenant_integrations` no banco mestre (`config` em JSON, com as mesmas chaves em camelCase):

| Variável | Uso |
|---|---|
| `RNDS_ENVIRONMENT` | `homologacao` ou `producao`: define os endereços oficiais acima |
| `RNDS_UF` | UF do estabelecimento (só na produção) |
| `RNDS_AUTH_URL`, `RNDS_EHR_URL` | opcionais: endereços manuais (sobrepõem os oficiais) |
| `RNDS_CERT_PFX` | caminho do `.pfx` ou `r2:<chave>` no armazenamento de objetos |
| `RNDS_CERT_PASSPHRASE` | senha do `.pfx` |
| `RNDS_REQUESTER_CNS` | CNS do profissional responsável pelas requisições (cabeçalho `Authorization`) |
| `RNDS_REQUESTER_CPF` | compatibilidade (simulador e configurações antigas); use o CNS |
| `requesterId` (só por instituição) | identificador do solicitante recebido no credenciamento |

Sem `RNDS_ENVIRONMENT` e sem endereços, a API usa o simulador local (`MOCKS_URL`), que é o que roda na
demonstração. O envio efetivo é ligado pela plataforma na preferência `rndsEnabled` da instituição.

## 4. Conferir e acompanhar

- **Administração > Integrações**: situação da configuração (ambiente, endereços, solicitante, certificado), a
  fila de envio por estado e o botão **Testar conexão**, que obtém um token novo e consulta o próprio CNES.
- A fila (outbox) é processada pelos jobs (`POST /api/jobs/tick`, Cron Trigger a cada 5 minutos na Cloudflare)
  com novas tentativas e descarte dos erros permanentes; `GET /api/integrations/outbox` lista os últimos envios.

## 5. Perfis FHIR

Base canônica dos perfis, sistemas de código e conjuntos de valores: `http://www.saude.gov.br/fhir/r4`.
NamingSystems das buscas: `http://rnds.saude.gov.br/fhir/r4/NamingSystem/{cpf,cns,cnes}`.

| Documento | Perfil usado | Situação |
|---|---|---|
| RAC (Composition) | `BRRegistroAtendimentoClinico` | conferido com o pacote oficial (0.5.0) |
| Contato assistencial (Encounter) | `BRContatoAssistencial-1.0` | conferido |
| Problema/diagnóstico (Condition) | `BRProblemaDiagnostico` | conferido |
| Procedimento (Procedure) | `BRProcedimentoRealizado-1.0` | conferido |
| Sinais vitais (Observation) | `BRMedidaObservada` | conferido |
| Lotação (PractitionerRole) | `BRLotacaoProfissional-1.0` | conferido |
| Medicamento (Medication) | `BRMedicamento` | conferido |
| Imunização (Immunization + Composition) | `BRImunobiologicoAdministrado-2.0`, `BRRegistroImunobiologicoAdministrado-2.0` | não consta do pacote público; confirmar na homologação |
| Dispensação (MedicationDispense + Composition) | `BRDispensacaoMedicamento-1.0`, `BRRegistroDispensacaoMedicamento-1.0` | idem |
| Sumário de alta (Composition, Encounter, MedicationRequest) | `BRSumarioAlta-1.0`, `BRInternacao-1.0`, `BRPrescricaoAlta-1.0` | idem |

Todos os nomes ficam em `packages/fhir/src/rnds.ts`. O pacote oficial consultado foi
`br.ufg.cgis.rnds-lite` 0.5.0 (espelho do projeto "Rede Nacional de Dados em Saúde" no Simplifier); o projeto
publica também os perfis "BR Core" mais novos, que ainda não valem para os documentos enviados aqui. A
homologação com o DATASUS é o passo que fecha as versões.

## 6. Regulação assistencial (Portaria GM/MS 6.656/2025)

A Portaria GM/MS nº 6.656, de 7 de março de 2025, tornou obrigatório o envio à RNDS de **todos os registros de
solicitação de procedimentos ou encaminhamento a serviços de atenção especializada**, no Modelo de Informação
da Regulação Assistencial (MIRA, Portaria Conjunta SAES/SEIDIGI nº 3/2023). Sistemas próprios (art. 3º, II e
IV) transmitem **diariamente, com as informações até o dia anterior** (art. 5º); o status "atendido/internado"
e a data de execução são facultativos (art. 2º, §3º). SISREG e e-SUS Regulação transmitem sozinhos (art. 4º).

O OmniSaúde implementa o **Registro de Regulação Assistencial (RIRA)**, guia oficial `br.gov.saude.rira.fhir`
1.0.0-release (publicado em 29/10/2026; perfis de 2023 no projeto RNDS do Simplifier, atualizados em
12/12/2025): um Bundle `document` com

| Recurso | Perfil | Conteúdo |
|---|---|---|
| Composition | `BRRegulacaoAssistencial` | tipo `RA`, modalidade (`04` hospitalar, `09` ambulatorial), indivíduo (CPF ou CNS, sistema `BRIndividuo-1.0`), data (só dia), autor (CNES da central reguladora), **um evento** com a situação (`pending`, `returned-to-requester`, `booked`, `attended`, `cancelled`, `absence`, `excluded`), a data da alteração e o estabelecimento que a fez; `relatesTo replaces` para o documento anterior |
| ServiceRequest | `BRRequisicaoRegulacaoAssistencial` | status/intent conforme a situação, modalidade, caráter (`routine`/`urgent`), procedimento SIGTAP, solicitante (CNES), data da solicitação, CBO do executante, executante (CNES, só quando agendada/atendida/falta), execução, motivo |
| Appointment | `BRAgendamentoRegulacaoAssistencial` | status conforme a situação, modalidade, procedimento, CBO, caráter, motivo, regulador, início/fim do agendamento, data da autorização, paciente |
| Condition | `BRProblemaDiagnostico` | motivo (CID-10 ou CIAP-2), obrigatório para solicitações a partir de 1/1/2025 (`mira-1`) |

As invariantes `mira-1` a `mira-19` (executante proibido quando pendente, obrigatório quando agendada, data de
execução quando atendida ou falta, estados FHIR por situação) estão em `packages/shared/src/rnds-regulacao.ts`
e no construtor `buildRegulationBundle` (`packages/fhir/src/builders/regulation.ts`), com testes.

**Mapeamento das situações** (`statusMiraAmbulatorial` / `statusMiraLeito`): pendente, em análise e
autorizada sem agendamento → `pending`; devolvida → `returned-to-requester`; agendada (ou vaga autorizada com
destino) → `booked`; realizada / internada → `attended`; falta → `absence`; negada e cancelada → `cancelled`.

**Como funciona**: cada solicitação (ambulatorial ou de vaga de leito) e cada mudança de situação grava uma
mensagem `RNDS_REGULACAO` no outbox, na mesma transação; o job de integração monta o documento a partir do
estado atual, valida e envia (com novas tentativas e descarte dos erros permanentes: pessoa sem CPF/CNS, vaga
sem SIGTAP). A tela **Regulação > Envio à RNDS** mostra o painel (fila, enviados, erros, atrasados há mais de
24 h), os documentos por solicitação, a pré-visualização do FHIR validado, o reenvio, o enfileiramento da
situação atual e a **carga inicial** (todas as solicitações que ainda não têm documento).

Configuração adicional: `RNDS_REGULATOR_CNES` (ou `regulatorCnes` em `tenant_integrations`) com o CNES da
central de regulação, autora dos documentos; sem ele, o autor é a unidade que alterou a situação.

Pontos a confirmar na homologação: a referência do documento substituído (`Composition/<id>` devolvido no
`Location`) e a aceitação do identificador `BRIndividuo-1.0`/`BREstabelecimentoSaude-1.0` como nos exemplos
oficiais. A integração direta com o **e-SUS Regulação** não tem API pública: a wiki do MS e o FAQ só tratam de
adesão e operação; pela portaria, o caminho dos sistemas próprios é a RNDS, e o campo **código no SISREG /
e-SUS Regulação** das solicitações serve para conciliar os registros quando o município usa os dois.
