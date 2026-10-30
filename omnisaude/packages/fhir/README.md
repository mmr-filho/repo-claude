# @omnisaude/fhir

Documentos **HL7 FHIR R4** para a **RNDS** e consulta ao **CADSUS**.

## Módulos

| Módulo | O que faz |
|---|---|
| `rnds` | **Todos** os identificadores da RNDS num só lugar: NamingSystems (`cpf`, `cns`, `cnes`), CodeSystems (CID-10, CIAP-2, SIGTAP, CBO, imunobiológicos...), perfis (StructureDefinition) e tipos de documento. |
| `builders` | `buildRacBundle` (Registro de Atendimento Clínico), `buildImmunizationBundle`, `buildDispensationBundle`, `buildDischargeSummaryBundle`. Geram `Bundle` do tipo `document`, com a `Composition` primeiro, `fullUrl` em `urn:uuid:` e `meta.profile`. Paciente, profissional e estabelecimento são referenciados por identificador (CPF/CNS/CNES), como a RNDS espera; a lotação (profissional + CBO + CNES) vai num `PractitionerRole`. |
| `validate` | `validateRndsBundle(bundle)` → `{ valid, issues[] }`: estrutura, Composition primeiro, identificador do Bundle, referências internas resolvíveis, CPF/CNS/CNES válidos, datas no formato FHIR e perfis declarados. |
| `client` | `RndsClient` com **mTLS** (certificado ICP-Brasil em PFX ou PEM): `getAccessToken()` (cache até expirar), `sendBundle()` (devolve o id do cabeçalho `Location`; renova o token uma vez em 401) e `searchPatient()`. Erros viram `RndsError` com o `OperationOutcome`. |
| `cadsus` | `CadsusClient` / `RndsCadsusClient` (`findByCpf`, `findByCns`) e o mapeamento `Patient` ↔ `CadsusCitizen`. |

## Uso

```ts
import { buildRacBundle, RndsCadsusClient, RndsClient, validateRndsBundle } from '@omnisaude/fhir';

const rnds = new RndsClient({
  authUrl: 'https://ehr-auth-hmg.saude.gov.br',
  ehrUrl: 'https://to-ehr-services.hmg.saude.gov.br',
  tls: { pfx: readFileSync('certificado.pfx'), passphrase: process.env.RNDS_PFX_SENHA },
  requesterCpf: profissional.cpf,
});

const bundle = buildRacBundle({ rndsRequesterId, localId: atendimento.id, patient, practitioner, establishment, careLevel: 'ATENCAO_BASICA', encounter, problems, procedures, vitals });
const check = validateRndsBundle(bundle);
if (check.valid) await rnds.sendBundle(bundle); // em produção, via outbox + fila

const cidadao = await new RndsCadsusClient(rnds).findByCpf('52998224725');
```

Contra o simulador (`infra/mocks`), use URLs `http://...` e omita `tls`.

## Limitações (importante)

- **Perfis, versões e códigos precisam ser confirmados** no Guia de Implementação vigente da RNDS e no ambiente de homologação. Os valores de `src/rnds.ts` são o ponto único de ajuste; os que mais mudam são as versões dos perfis (`-1.0`, `-2.0`, `-3.2`) e os códigos de `BRTipoDocumento`.
- O validador local **não substitui** o validador oficial (HL7 Validator com o pacote da RNDS): ele pega erros estruturais comuns antes do envio.
- Premissas do `RndsClient` (documentadas no código): token por `GET {authUrl}/api/token` com o certificado cliente; cabeçalhos `X-Authorization-Server: Bearer <token>` e `Authorization: <CPF do solicitante>`.
- Procedimentos com quantidade > 1 no RAC viram um `Procedure` por execução (até 50).
- Filiação no CADSUS: lida tanto de extensões (`BRNomeMae`/`BRNomePai`) quanto de `Patient.contact` (MTH/FTH); confirme o formato real retornado pela RNDS.
- Os tipos públicos usam `@types/fhir` (`fhir/r4`), resolvido pela instalação do monorepo.
