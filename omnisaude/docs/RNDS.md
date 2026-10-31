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
