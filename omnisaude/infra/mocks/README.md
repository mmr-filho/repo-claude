# @omnisaude/mocks

Servidor HTTP simulado (sem dependências externas) para desenvolvimento, `docker-compose` e testes de integração da API.

```bash
npm run dev -w @omnisaude/mocks          # tsx, porta 4010 (PORT=...)
npm run build -w @omnisaude/mocks && npm run start -w @omnisaude/mocks
```

Em testes: `createMockServer()` devolve um `http.Server` (com `.state` em memória) para subir na porta 0.

| Serviço | Rotas |
|---|---|
| RNDS (auth) | `GET/POST /rnds/auth/api/token` → `{ access_token, expires_in }` |
| RNDS (EHR) | `POST /rnds/ehr/api/fhir/r4/Bundle`: valida com `@omnisaude/fhir`; `201` + `Location`, ou `422` com `OperationOutcome`. Exige `X-Authorization-Server: Bearer <token>` e `Authorization: <CPF>` |
| CADSUS | `GET /rnds/ehr/api/fhir/r4/Patient?identifier=<sistema>\|<valor>` → `Bundle` searchset com os cidadãos de `MOCK_CITIZENS` |
| Inspeção RNDS | `GET /rnds/_received`, `DELETE /rnds/_received` |
| SEFAZ | `GET /sefaz/nfe?cnpj=<destinatário>` → NF-e (procNFe) destinadas; `GET /sefaz/nfe/<chave>` → XML |
| WhatsApp | `POST /whatsapp/:versão/:phoneNumberId/messages` (exige `Authorization: Bearer`) → `{ messages: [{ id }] }` |
| Inspeção WhatsApp | `GET /whatsapp/_sent`, `DELETE /whatsapp/_sent` |
| Saúde | `GET /health` |

Para apontar os clientes reais para o simulador: `RndsClient({ authUrl: 'http://mocks:4010/rnds/auth', ehrUrl: 'http://mocks:4010/rnds/ehr', ... })` e `WhatsAppCloudClient({ baseUrl: 'http://mocks:4010/whatsapp', ... })`.

## Fixtures

- `MOCK_CITIZENS`: seis cidadãos **fictícios**, com CPF e CNS de dígitos válidos (inclui pessoa só com CNS, recém-nascido, nome social e CNS provisório).
- `fixtures/*.xml`: duas NF-e 4.00 **fictícias** de medicamentos (ambiente de homologação, sem assinatura digital) para o CNPJ do consórcio de demonstração (`DEMO_DEST_CNPJ = 04512345000185`): chave de acesso de 44 dígitos com DV correto, `cEAN` com GTIN-13 válido, NCM 3004, grupo `<rastro>` (nLote, qLote, dFab, dVal; um item com dois lotes) e grupo `<med>` (cProdANVISA, vPMC).

## Limitações

- O simulador da SEFAZ é REST/JSON; o serviço real de distribuição (NFeDistribuicaoDFe) é SOAP com mTLS e devolve documentos compactados (gzip + base64).
- Não há mTLS no simulador da RNDS; tokens valem 30 min e ficam em memória.
