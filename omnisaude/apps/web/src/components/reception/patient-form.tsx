'use client';

import { ESCOLARIDADE, RACA_COR, SITUACAO_TRABALHO, UFS, codeIn, isValidCns, isValidCpf, onlyDigits } from '@omnisaude/shared';
import { Camera, FileText, IdCard, ScanSearch, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, ApiError, errorMessage } from '@/lib/api';
import { fmtDate, formatCns } from '@/lib/format';
import { fileToPhoto, isNative, takeNativePhoto, type Photo } from '@/lib/native';
import type { PatientSummary } from '@/lib/types';
import { WebcamDialog } from './camera-capture';

export interface PatientFormValues {
  name: string;
  socialName: string;
  birthDate: string;
  sex: '' | 'M' | 'F';
  cpf: string;
  cns: string;
  motherName: string;
  fatherName: string;
  racaCor: string;
  phone: string;
  whatsappOptIn: boolean;
  email: string;
  cep: string;
  street: string;
  number: string;
  complement: string;
  district: string;
  city: string;
  uf: string;
  ibgeCode: string;
  rg: string;
  rgIssuer: string;
  rgUf: string;
  nis: string;
  birthIbgeCode: string;
  education: string;
  workSituation: string;
  occupationCbo: string;
  homeless: boolean;
  bolsaFamilia: boolean;
}

export const EMPTY_PATIENT: PatientFormValues = {
  name: '',
  socialName: '',
  birthDate: '',
  sex: '',
  cpf: '',
  cns: '',
  motherName: '',
  fatherName: '',
  racaCor: '99',
  phone: '',
  whatsappOptIn: false,
  email: '',
  cep: '',
  street: '',
  number: '',
  complement: '',
  district: '',
  city: '',
  uf: '',
  ibgeCode: '',
  rg: '',
  rgIssuer: '',
  rgUf: '',
  nis: '',
  birthIbgeCode: '',
  education: '',
  workSituation: '',
  occupationCbo: '',
  homeless: false,
  bolsaFamilia: false,
};

interface Citizen {
  cpf?: string;
  cns: string[];
  name: string;
  socialName?: string;
  motherName?: string;
  fatherName?: string;
  birthDate?: string;
  sex?: 'M' | 'F' | 'I';
  phones: string[];
  email?: string;
  address?: { line?: string; district?: string; city?: string; ibgeCode?: string; state?: string; postalCode?: string };
}

type Duplicate = PatientSummary & { reason: 'CPF' | 'CNS' | 'NOME_NASCIMENTO' };

interface OcrResult {
  source: 'IA' | 'TEXTO';
  extracted: {
    docType: string;
    fullName: string | null;
    motherName: string | null;
    fatherName: string | null;
    birthDate: string | null;
    cpf: string | null;
    cns: string | null;
    rg: string | null;
    sex: 'M' | 'F' | null;
    confidence: number;
  };
  issues: { field: string; severity: 'erro' | 'aviso'; message: string }[];
  valid: boolean;
  cadsus: { found: true; citizen: Citizen; localMatches: Duplicate[] } | { found: false } | { error: string } | null;
  localMatches: Duplicate[];
  divergences: string[];
}

const DOC_LABEL: Record<string, string> = { RG: 'RG', CNH: 'CNH', CERTIDAO_NASCIMENTO: 'Certidão de nascimento', CARTAO_SUS: 'Cartão SUS', OUTRO: 'Documento' };

export function toPatientPayload(v: PatientFormValues) {
  const opt = (s: string) => (s.trim() ? s.trim() : null);
  return {
    name: v.name.trim(),
    socialName: opt(v.socialName),
    birthDate: v.birthDate,
    sex: v.sex as 'M' | 'F',
    cpf: opt(onlyDigits(v.cpf)),
    cns: opt(onlyDigits(v.cns)),
    motherName: opt(v.motherName),
    fatherName: opt(v.fatherName),
    racaCor: v.racaCor as keyof typeof RACA_COR,
    phone: opt(onlyDigits(v.phone)),
    whatsappOptIn: v.whatsappOptIn,
    email: opt(v.email),
    rg: opt(v.rg),
    rgIssuer: opt(v.rgIssuer),
    rgUf: opt(v.rgUf),
    nis: opt(onlyDigits(v.nis)),
    birthIbgeCode: opt(onlyDigits(v.birthIbgeCode)),
    education: opt(v.education),
    workSituation: opt(v.workSituation),
    occupationCbo: opt(onlyDigits(v.occupationCbo)),
    homeless: v.homeless,
    bolsaFamilia: v.bolsaFamilia,
    address: {
      cep: opt(onlyDigits(v.cep)),
      street: opt(v.street),
      number: opt(v.number),
      complement: opt(v.complement),
      district: opt(v.district),
      city: opt(v.city),
      uf: opt(v.uf),
      ibgeCode: opt(onlyDigits(v.ibgeCode)),
    },
  };
}

interface CepResult {
  cep: string;
  street: string | null;
  district: string | null;
  city: string | null;
  uf: string | null;
  ibgeCode: string | null;
}

/** Campos do cadastro (reaproveitados na edição). */
export function PatientFields({ values, onChange }: { values: PatientFormValues; onChange: (v: PatientFormValues) => void }) {
  const set = <K extends keyof PatientFormValues>(k: K, val: PatientFormValues[K]) => onChange({ ...values, [k]: val });
  const cpfErr = values.cpf && !isValidCpf(values.cpf) ? 'CPF inválido' : null;
  const cnsErr = values.cns && !isValidCns(values.cns) ? 'CNS inválido' : null;
  const [cepStatus, setCepStatus] = useState<string | null>(null);
  const lastCep = useRef('');
  const latest = useRef(values);
  latest.current = values;
  // Busca o endereço quando o CEP fica completo (ViaCEP via API); número e complemento continuam com o usuário.
  const cepDigits = onlyDigits(values.cep);
  useEffect(() => {
    if (cepDigits.length !== 8 || cepDigits === lastCep.current) return;
    lastCep.current = cepDigits;
    let cancelled = false;
    setCepStatus('Buscando endereço…');
    api
      .get<CepResult>(`/patients/cep/${cepDigits}`)
      .then((r) => {
        if (cancelled) return;
        const v = latest.current;
        onChange({ ...v, street: r.street ?? v.street, district: r.district ?? v.district, city: r.city ?? v.city, uf: r.uf ?? v.uf, ibgeCode: r.ibgeCode ?? v.ibgeCode });
        setCepStatus(`${r.city ?? ''}${r.uf ? `/${r.uf}` : ''}`.trim() || null);
      })
      .catch((err) => {
        if (!cancelled) setCepStatus(err instanceof ApiError && err.status === 404 ? 'CEP não encontrado' : 'Sem consulta de CEP; preencha manualmente');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cepDigits]);
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <Field label="Nome completo (civil)" htmlFor="pf-name" className="sm:col-span-2">
        <Input id="pf-name" value={values.name} onChange={(e) => set('name', e.target.value)} required autoComplete="off" />
      </Field>
      <Field label="Nome social" htmlFor="pf-social" hint="Usado no atendimento e no painel">
        <Input id="pf-social" value={values.socialName} onChange={(e) => set('socialName', e.target.value)} />
      </Field>
      <Field label="Data de nascimento" htmlFor="pf-birth">
        <Input id="pf-birth" type="date" value={values.birthDate} onChange={(e) => set('birthDate', e.target.value)} required />
      </Field>
      <Field label="Sexo" htmlFor="pf-sex">
        <Select id="pf-sex" value={values.sex} onChange={(e) => set('sex', e.target.value as PatientFormValues['sex'])} required>
          <option value="">Selecione</option>
          <option value="F">Feminino</option>
          <option value="M">Masculino</option>
        </Select>
      </Field>
      <Field label="Raça/cor" htmlFor="pf-raca">
        <Select id="pf-raca" value={values.racaCor} onChange={(e) => set('racaCor', e.target.value)}>
          {Object.entries(RACA_COR).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="CPF" htmlFor="pf-cpf" error={cpfErr}>
        <Input id="pf-cpf" value={values.cpf} onChange={(e) => set('cpf', e.target.value)} inputMode="numeric" placeholder="000.000.000-00" />
      </Field>
      <Field label="CNS (Cartão SUS)" htmlFor="pf-cns" error={cnsErr}>
        <Input id="pf-cns" value={values.cns} onChange={(e) => set('cns', e.target.value)} inputMode="numeric" placeholder="000 0000 0000 0000" />
      </Field>
      <Field label="Telefone celular" htmlFor="pf-phone">
        <Input id="pf-phone" value={values.phone} onChange={(e) => set('phone', e.target.value)} inputMode="tel" placeholder="(11) 99999-9999" />
      </Field>
      <Field label="Nome da mãe" htmlFor="pf-mother" className="sm:col-span-2 lg:col-span-1">
        <Input id="pf-mother" value={values.motherName} onChange={(e) => set('motherName', e.target.value)} />
      </Field>
      <Field label="Nome do pai" htmlFor="pf-father">
        <Input id="pf-father" value={values.fatherName} onChange={(e) => set('fatherName', e.target.value)} />
      </Field>
      <Field label="E-mail" htmlFor="pf-email">
        <Input id="pf-email" type="email" value={values.email} onChange={(e) => set('email', e.target.value)} />
      </Field>
      <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2 lg:col-span-3">
        <input type="checkbox" className="h-5 w-5" checked={values.whatsappOptIn} onChange={(e) => set('whatsappOptIn', e.target.checked)} />
        Aceita receber confirmações de consulta e lembretes de medicação pelo WhatsApp
      </label>
      <h3 className="mt-2 text-sm font-semibold text-slate-700 sm:col-span-2 lg:col-span-3">Documentos</h3>
      <Field label="RG" htmlFor="pf-rg">
        <Input id="pf-rg" value={values.rg} onChange={(e) => set('rg', e.target.value)} />
      </Field>
      <Field label="Órgão emissor" htmlFor="pf-rg-issuer">
        <Input id="pf-rg-issuer" value={values.rgIssuer} onChange={(e) => set('rgIssuer', e.target.value)} placeholder="SSP" />
      </Field>
      <Field label="UF do RG" htmlFor="pf-rg-uf">
        <Select id="pf-rg-uf" value={values.rgUf} onChange={(e) => set('rgUf', e.target.value)}>
          <option value="">—</option>
          {UFS.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="NIS / PIS" htmlFor="pf-nis" hint="Bolsa Família e benefícios">
        <Input id="pf-nis" value={values.nis} onChange={(e) => set('nis', e.target.value)} inputMode="numeric" />
      </Field>
      <Field label="Município de nascimento (IBGE)" htmlFor="pf-birth-ibge" hint="7 dígitos">
        <Input id="pf-birth-ibge" value={values.birthIbgeCode} onChange={(e) => set('birthIbgeCode', e.target.value.replace(/\D/g, '').slice(0, 7))} inputMode="numeric" />
      </Field>
      <h3 className="mt-2 text-sm font-semibold text-slate-700 sm:col-span-2 lg:col-span-3">Dados sociais</h3>
      <Field label="Escolaridade" htmlFor="pf-edu">
        <Select id="pf-edu" value={values.education} onChange={(e) => set('education', e.target.value)}>
          <option value="">Não informada</option>
          {codeIn(ESCOLARIDADE).map((k) => (
            <option key={k} value={k}>
              {ESCOLARIDADE[k]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Situação no mercado de trabalho" htmlFor="pf-work">
        <Select id="pf-work" value={values.workSituation} onChange={(e) => set('workSituation', e.target.value)}>
          <option value="">Não informada</option>
          {codeIn(SITUACAO_TRABALHO).map((k) => (
            <option key={k} value={k}>
              {SITUACAO_TRABALHO[k]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Ocupação (CBO)" htmlFor="pf-cbo" hint="6 dígitos">
        <Input id="pf-cbo" value={values.occupationCbo} onChange={(e) => set('occupationCbo', e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" />
      </Field>
      <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2 lg:col-span-3">
        <input type="checkbox" className="h-5 w-5" checked={values.homeless} onChange={(e) => set('homeless', e.target.checked)} />
        Pessoa em situação de rua
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2 lg:col-span-3">
        <input type="checkbox" className="h-5 w-5" checked={values.bolsaFamilia} onChange={(e) => set('bolsaFamilia', e.target.checked)} />
        Família beneficiária do Bolsa Família (condicionalidades de saúde)
      </label>
      <h3 className="mt-2 text-sm font-semibold text-slate-700 sm:col-span-2 lg:col-span-3">Endereço</h3>
      <Field label="CEP" htmlFor="pf-cep" hint={cepStatus ?? 'Preenche o endereço automaticamente'}>
        <Input id="pf-cep" value={values.cep} onChange={(e) => set('cep', e.target.value)} inputMode="numeric" />
      </Field>
      <Field label="Logradouro" htmlFor="pf-street" className="lg:col-span-2">
        <Input id="pf-street" value={values.street} onChange={(e) => set('street', e.target.value)} />
      </Field>
      <Field label="Número" htmlFor="pf-number">
        <Input id="pf-number" value={values.number} onChange={(e) => set('number', e.target.value)} />
      </Field>
      <Field label="Complemento" htmlFor="pf-compl">
        <Input id="pf-compl" value={values.complement} onChange={(e) => set('complement', e.target.value)} />
      </Field>
      <Field label="Bairro" htmlFor="pf-district">
        <Input id="pf-district" value={values.district} onChange={(e) => set('district', e.target.value)} />
      </Field>
      <Field label="Município" htmlFor="pf-city">
        <Input id="pf-city" value={values.city} onChange={(e) => set('city', e.target.value)} />
      </Field>
      <Field label="UF" htmlFor="pf-uf">
        <Select id="pf-uf" value={values.uf} onChange={(e) => set('uf', e.target.value)}>
          <option value="">—</option>
          {UFS.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Código IBGE do município" htmlFor="pf-ibge">
        <Input id="pf-ibge" value={values.ibgeCode} onChange={(e) => set('ibgeCode', e.target.value.replace(/\D/g, '').slice(0, 7))} inputMode="numeric" />
      </Field>
    </div>
  );
}

/** Novo cadastro com leitura de documento (OCR/IA), conferência no CADSUS e checagem de duplicidade. */
export function NewPatientForm({ onCreated }: { onCreated: (p: PatientSummary) => void }) {
  const toast = useToast();
  const [values, setValues] = useState<PatientFormValues>(EMPTY_PATIENT);
  const [ocr, setOcr] = useState<OcrResult | null>(null);
  const [reading, setReading] = useState(false);
  const [webcam, setWebcam] = useState(false);
  const [ocrText, setOcrText] = useState('');
  const [textOpen, setTextOpen] = useState(false);
  const [cadsus, setCadsus] = useState<Citizen | null>(null);
  const [cadsusMsg, setCadsusMsg] = useState<string | null>(null);
  const [cadsusValidated, setCadsusValidated] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dupes, setDupes] = useState<{ list: Duplicate[]; needsConfirmation: boolean } | null>(null);
  const file = useRef<HTMLInputElement>(null);

  function applyExtraction(r: OcrResult) {
    const x = r.extracted;
    setValues((v) => ({
      ...v,
      name: x.fullName ?? v.name,
      motherName: x.motherName ?? v.motherName,
      fatherName: x.fatherName ?? v.fatherName,
      birthDate: x.birthDate ?? v.birthDate,
      cpf: x.cpf ?? v.cpf,
      cns: x.cns ?? v.cns,
      sex: x.sex ?? v.sex,
    }));
    if (r.cadsus && 'found' in r.cadsus && r.cadsus.found) setCadsus(r.cadsus.citizen);
  }

  async function readDocument(body: { image?: string; mediaType?: string; text?: string }) {
    setReading(true);
    try {
      const r = await api.post<OcrResult>('/integrations/ocr', body);
      setOcr(r);
      applyExtraction(r);
      toast.success(`${DOC_LABEL[r.extracted.docType] ?? 'Documento'} lido: confira os campos preenchidos.`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setReading(false);
    }
  }

  const sendPhoto = (p: Photo) => readDocument({ image: p.base64, mediaType: p.mediaType });

  async function photoButton() {
    if (isNative()) {
      try {
        const p = await takeNativePhoto();
        if (p) await sendPhoto(p);
      } catch (err) {
        toast.error(errorMessage(err));
      }
    } else setWebcam(true);
  }

  async function lookupCadsus() {
    const cpf = onlyDigits(values.cpf);
    const cns = onlyDigits(values.cns);
    const q = cpf ? `cpf=${cpf}` : cns ? `cns=${cns}` : null;
    if (!q) {
      setCadsusMsg('Informe CPF ou CNS para consultar o CADSUS.');
      return;
    }
    setCadsusMsg(null);
    try {
      const r = await api.get<{ found: boolean; citizen?: Citizen; localMatches?: Duplicate[] }>(`/integrations/cadsus?${q}`);
      if (!r.found) setCadsusMsg('Cidadão não encontrado no CADSUS.');
      else {
        setCadsus(r.citizen!);
        if (r.localMatches?.length) setDupes({ list: r.localMatches, needsConfirmation: false });
      }
    } catch (err) {
      setCadsusMsg(errorMessage(err));
    }
  }

  function fillFromCadsus(c: Citizen) {
    setValues((v) => ({
      ...v,
      name: c.name ?? v.name,
      socialName: c.socialName ?? v.socialName,
      motherName: c.motherName ?? v.motherName,
      fatherName: c.fatherName ?? v.fatherName,
      birthDate: c.birthDate ?? v.birthDate,
      sex: c.sex === 'M' || c.sex === 'F' ? c.sex : v.sex,
      cpf: c.cpf ?? v.cpf,
      cns: c.cns[0] ?? v.cns,
      phone: c.phones[0] ?? v.phone,
      email: c.email ?? v.email,
      cep: c.address?.postalCode ?? v.cep,
      street: c.address?.line ?? v.street,
      district: c.address?.district ?? v.district,
      ibgeCode: c.address?.ibgeCode ?? v.ibgeCode,
    }));
    setCadsusValidated(true);
    toast.info('Dados do CADSUS aplicados ao formulário.');
  }

  async function save(confirmNotDuplicate = false) {
    if (!values.name || !values.birthDate || !values.sex) {
      toast.error('Preencha nome, data de nascimento e sexo.');
      return;
    }
    setSaving(true);
    try {
      const created = await api.post<PatientSummary>('/patients', { ...toPatientPayload(values), confirmNotDuplicate, cadsusValidated });
      toast.success(`Paciente ${created.name} cadastrado.`);
      setValues(EMPTY_PATIENT);
      setOcr(null);
      setCadsus(null);
      setDupes(null);
      setCadsusValidated(false);
      onCreated(created);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const d = (err.details ?? {}) as { duplicates?: Duplicate[]; needsConfirmation?: boolean };
        setDupes({ list: d.duplicates ?? [], needsConfirmation: !!d.needsConfirmation });
      } else toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Leitura de documento"
          description="RG, CNH, certidão de nascimento ou Cartão SUS: os campos são preenchidos automaticamente e conferidos com o CADSUS."
          actions={
            <>
              <Button variant="secondary" onClick={photoButton} loading={reading}>
                <Camera className="h-4 w-4" /> {isNative() ? 'Fotografar' : 'Webcam'}
              </Button>
              <Button variant="secondary" onClick={() => file.current?.click()} disabled={reading}>
                <Upload className="h-4 w-4" /> Enviar foto
              </Button>
              <Button variant="ghost" onClick={() => setTextOpen(true)} disabled={reading}>
                <FileText className="h-4 w-4" /> Colar texto
              </Button>
            </>
          }
        />
        <input
          ref={file}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) await sendPhoto(await fileToPhoto(f));
          }}
        />
        {ocr && (
          <CardBody className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <IdCard className="h-4 w-4 text-brand-600" />
              <span className="font-medium">{DOC_LABEL[ocr.extracted.docType] ?? 'Documento'}</span>
              <Badge tone={ocr.source === 'IA' ? 'violet' : 'slate'}>{ocr.source === 'IA' ? 'Leitura por IA' : 'Texto do OCR'}</Badge>
              <Badge tone={ocr.valid ? 'green' : 'amber'}>{ocr.valid ? 'Dígitos conferidos' : 'Revisar campos'}</Badge>
              <span className="text-slate-500">Confiança {(ocr.extracted.confidence * 100).toFixed(0)}%</span>
            </div>
            {ocr.issues.length > 0 && (
              <Alert tone={ocr.issues.some((i) => i.severity === 'erro') ? 'error' : 'warn'} title="Pontos de atenção">
                <ul className="list-inside list-disc">
                  {ocr.issues.map((i, idx) => (
                    <li key={idx}>{i.message}</li>
                  ))}
                </ul>
              </Alert>
            )}
            {ocr.divergences.length > 0 && (
              <Alert tone="warn" title="Divergências com o CADSUS">
                {ocr.divergences.join('; ')}
              </Alert>
            )}
            {ocr.cadsus && 'error' in ocr.cadsus && <Alert tone="warn">CADSUS indisponível: {ocr.cadsus.error}</Alert>}
          </CardBody>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Dados do paciente"
          actions={
            <Button variant="secondary" onClick={lookupCadsus}>
              <ScanSearch className="h-4 w-4" /> Consultar CADSUS
            </Button>
          }
        />
        <CardBody className="flex flex-col gap-4">
          {cadsusMsg && <Alert tone="info">{cadsusMsg}</Alert>}
          {cadsus && (
            <Alert tone="success" title="Cidadão encontrado no CADSUS">
              <p>
                {cadsus.name} · nasc. {fmtDate(cadsus.birthDate)} · CNS {cadsus.cns.map((c) => formatCns(c)).join(', ')}
                {cadsus.motherName ? ` · mãe ${cadsus.motherName}` : ''}
              </p>
              <Button size="sm" className="mt-2" onClick={() => fillFromCadsus(cadsus)}>
                Usar dados do CADSUS
              </Button>
            </Alert>
          )}
          {ocr && ocr.localMatches.length > 0 && <DuplicateList list={ocr.localMatches} title="Já existe cadastro parecido na rede" />}
          <PatientFields values={values} onChange={setValues} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setValues(EMPTY_PATIENT)}>
              Limpar
            </Button>
            <Button onClick={() => save(false)} loading={saving}>
              Cadastrar paciente
            </Button>
          </div>
        </CardBody>
      </Card>

      <WebcamDialog open={webcam} onOpenChange={setWebcam} onPhoto={sendPhoto} />
      <Dialog
        open={textOpen}
        onOpenChange={setTextOpen}
        title="Texto lido do documento"
        description="Cole o texto reconhecido pelo leitor/OCR do aparelho."
        footer={
          <Button
            onClick={async () => {
              setTextOpen(false);
              await readDocument({ text: ocrText });
            }}
            disabled={ocrText.trim().length < 10}
          >
            Interpretar
          </Button>
        }
      >
        <Textarea value={ocrText} onChange={(e) => setOcrText(e.target.value)} rows={8} aria-label="Texto do documento" />
      </Dialog>
      <Dialog
        open={!!dupes}
        onOpenChange={(o) => !o && setDupes(null)}
        title={dupes?.needsConfirmation ? 'Possível duplicidade' : 'Cadastro já existente'}
        description={dupes?.needsConfirmation ? 'Há cadastro com o mesmo nome e data de nascimento. Confirme que é outra pessoa.' : 'Use o cadastro existente em vez de criar outro.'}
        footer={
          dupes?.needsConfirmation ? (
            <Button
              variant="danger"
              onClick={async () => {
                setDupes(null);
                await save(true);
              }}
            >
              É outra pessoa: cadastrar
            </Button>
          ) : undefined
        }
      >
        {dupes && (
          <DuplicateList
            list={dupes.list}
            onPick={(p) => {
              setDupes(null);
              onCreated(p);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

function DuplicateList({ list, title, onPick }: { list: Duplicate[]; title?: string; onPick?: (p: Duplicate) => void }) {
  const reason = { CPF: 'mesmo CPF', CNS: 'mesmo CNS', NOME_NASCIMENTO: 'mesmo nome e nascimento' };
  return (
    <div className="flex flex-col gap-2">
      {title && <p className="text-sm font-medium text-amber-800">{title}</p>}
      {list.map((d) => (
        <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
          <span>
            <b>{d.name}</b> · {fmtDate(d.birthDate)} · {d.motherName ? `mãe ${d.motherName} · ` : ''}
            <Badge tone="amber">{reason[d.reason]}</Badge>
          </span>
          {onPick && (
            <Button size="sm" variant="secondary" onClick={() => onPick(d)}>
              Usar este cadastro
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
