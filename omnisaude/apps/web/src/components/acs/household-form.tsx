'use client';

import {
  ABASTECIMENTO_AGUA,
  DESTINO_LIXO,
  ESGOTAMENTO,
  MATERIAL_PAREDES,
  RENDA_FAMILIAR,
  SITUACAO_MORADIA,
  TIPO_DOMICILIO,
  TIPO_IMOVEL,
  TRATAMENTO_AGUA,
  UFS,
  type DomicilioCampo,
  type OperacaoCampo,
} from '@omnisaude/shared';
import { LocateFixed } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { estaOnline, obterPosicao, uuid } from '@/lib/offline';
import { PessoaCampos, pessoaParaOp, pessoaValida, pessoaVazia, type PessoaForm } from './person-fields';

export interface DomicilioExistente extends DomicilioCampo {
  id: string;
}

type Form = Required<{ [K in keyof DomicilioCampo]: string }> & { electricity: string; rooms: string };

const vazio = (microArea: string | null): Form => ({
  cep: '',
  street: '',
  number: '',
  complement: '',
  district: '',
  city: '',
  uf: '',
  ibgeCode: '',
  latitude: '',
  longitude: '',
  propertyType: '01',
  dwellingType: '01',
  tenure: '01',
  wallMaterial: '',
  waterSupply: '01',
  waterTreatment: '',
  sewage: '',
  garbage: '',
  electricity: 'true',
  rooms: '',
  animals: '',
  microArea: microArea ?? '',
  notes: '',
});

const deExistente = (d: DomicilioExistente): Form => ({
  ...vazio(d.microArea ?? null),
  ...Object.fromEntries(
    Object.entries(d)
      .filter(([k]) => k !== 'id')
      .map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)]),
  ),
});

const opt = (t: Record<string, string>, vazioLabel = 'Não informado') => [
  <option key="" value="">
    {vazioLabel}
  </option>,
  ...Object.entries(t).map(([k, v]) => (
    <option key={k} value={k}>
      {v}
    </option>
  )),
];

/**
 * Cadastro domiciliar e territorial feito em campo: endereço, condições de moradia, posição no mapa e, no
 * domicílio novo, a família com o responsável (já cadastrado ou cadastrado agora, na mesma ida).
 */
export function HouseholdForm({
  aberto,
  onClose,
  existente,
  microAreaPadrao,
  municipio,
  onSalvar,
}: {
  aberto: boolean;
  onClose: () => void;
  existente: DomicilioExistente | null;
  microAreaPadrao: string | null;
  municipio: { city: string | null; uf: string | null; ibgeCode: string | null } | null;
  onSalvar: (ops: OperacaoCampo[], rotulo: string) => Promise<void>;
}) {
  const [f, setF] = useState<Form>(vazio(microAreaPadrao));
  const [responsavel, setResponsavel] = useState<'novo' | 'depois'>('novo');
  const [pessoa, setPessoa] = useState<PessoaForm>(pessoaVazia());
  const [renda, setRenda] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [localizando, setLocalizando] = useState(false);

  useEffect(() => {
    if (!aberto) return;
    setF(existente ? deExistente(existente) : { ...vazio(microAreaPadrao), city: municipio?.city ?? '', uf: municipio?.uf ?? '', ibgeCode: municipio?.ibgeCode ?? '' });
    setResponsavel('novo');
    setPessoa(pessoaVazia());
    setRenda('');
    setErro(null);
  }, [aberto, existente, microAreaPadrao, municipio]);

  const set = (k: keyof Form, v: string) => setF((x) => ({ ...x, [k]: v }));

  async function buscarCep(cep: string) {
    const digits = cep.replace(/\D/g, '');
    if (digits.length !== 8 || !estaOnline()) return;
    try {
      const r = await api.get<{ street?: string; district?: string; city?: string; uf?: string; ibgeCode?: string }>(`/patients/cep/${digits}`);
      setF((x) => ({ ...x, street: r.street || x.street, district: r.district || x.district, city: r.city || x.city, uf: r.uf || x.uf, ibgeCode: r.ibgeCode || x.ibgeCode }));
    } catch {
      // sem CEP automático: o agente preenche
    }
  }

  async function localizar() {
    setLocalizando(true);
    try {
      const p = await obterPosicao();
      setF((x) => ({ ...x, latitude: String(p.latitude), longitude: String(p.longitude) }));
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setLocalizando(false);
    }
  }

  async function salvar() {
    setErro(null);
    if (!f.street.trim()) return setErro('Informe o logradouro');
    if (!f.district.trim()) return setErro('Informe o bairro');
    const texto = (s: string) => (s.trim() ? s.trim() : null);
    const dados: DomicilioCampo = {
      cep: texto(f.cep),
      street: texto(f.street),
      number: texto(f.number),
      complement: texto(f.complement),
      district: texto(f.district),
      city: texto(f.city),
      uf: texto(f.uf),
      ibgeCode: texto(f.ibgeCode),
      latitude: f.latitude ? Number(f.latitude) : null,
      longitude: f.longitude ? Number(f.longitude) : null,
      propertyType: texto(f.propertyType),
      dwellingType: texto(f.dwellingType),
      tenure: texto(f.tenure),
      wallMaterial: texto(f.wallMaterial),
      waterSupply: texto(f.waterSupply),
      waterTreatment: texto(f.waterTreatment),
      sewage: texto(f.sewage),
      garbage: texto(f.garbage),
      electricity: f.electricity === '' ? null : f.electricity === 'true',
      rooms: f.rooms ? Number(f.rooms) : null,
      animals: texto(f.animals),
      microArea: texto(f.microArea),
      notes: texto(f.notes),
    };
    const registradoEm = new Date().toISOString();
    const rotulo = [dados.street, dados.number, dados.district].filter(Boolean).join(', ');
    const ops: OperacaoCampo[] = [];
    if (existente) {
      ops.push({ tipo: 'DOMICILIO', clientId: uuid(), registradoEm, householdId: existente.id, dados });
    } else {
      let responsavelClientId: string | null = null;
      if (responsavel === 'novo') {
        const invalido = pessoaValida(pessoa);
        if (invalido) return setErro(`Responsável: ${invalido}`);
        responsavelClientId = uuid();
        ops.push({
          tipo: 'PESSOA',
          clientId: responsavelClientId,
          registradoEm,
          dados: pessoaParaOp(pessoa, { cep: dados.cep, street: dados.street, number: dados.number, complement: dados.complement, district: dados.district, city: dados.city, uf: dados.uf, ibgeCode: dados.ibgeCode }),
        });
      }
      ops.push({ tipo: 'DOMICILIO', clientId: uuid(), registradoEm, dados, familia: { responsavelClientId, incomeBracket: renda || null } });
    }
    setBusy(true);
    try {
      await onSalvar(ops, `${existente ? 'Atualização do domicílio' : 'Novo domicílio'} · ${rotulo}`);
      onClose();
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={aberto}
      onOpenChange={(o) => !o && onClose()}
      title={existente ? 'Atualizar domicílio' : 'Novo domicílio'}
      description="Cadastro domiciliar e territorial do e-SUS"
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={salvar} loading={busy} id="domicilio-salvar">
            Salvar
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {erro && <Alert tone="error">{erro}</Alert>}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="CEP" htmlFor="dom-cep">
            <Input id="dom-cep" inputMode="numeric" value={f.cep} onChange={(e) => set('cep', e.target.value)} onBlur={(e) => buscarCep(e.target.value)} />
          </Field>
          <Field label="Logradouro" htmlFor="dom-rua" className="sm:col-span-2">
            <Input id="dom-rua" value={f.street} onChange={(e) => set('street', e.target.value)} required />
          </Field>
          <Field label="Número" htmlFor="dom-num">
            <Input id="dom-num" value={f.number} onChange={(e) => set('number', e.target.value)} placeholder="SN quando não houver" />
          </Field>
          <Field label="Complemento" htmlFor="dom-comp">
            <Input id="dom-comp" value={f.complement} onChange={(e) => set('complement', e.target.value)} />
          </Field>
          <Field label="Bairro" htmlFor="dom-bairro">
            <Input id="dom-bairro" value={f.district} onChange={(e) => set('district', e.target.value)} required />
          </Field>
          <Field label="Município" htmlFor="dom-cidade">
            <Input id="dom-cidade" value={f.city} onChange={(e) => set('city', e.target.value)} />
          </Field>
          <Field label="UF" htmlFor="dom-uf">
            <Select id="dom-uf" value={f.uf} onChange={(e) => set('uf', e.target.value)}>
              <option value="">—</option>
              {UFS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Microárea" htmlFor="dom-micro">
            <Input id="dom-micro" value={f.microArea} onChange={(e) => set('microArea', e.target.value)} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" type="button" onClick={localizar} loading={localizando}>
            <LocateFixed className="mr-1 h-4 w-4" /> Marcar posição no mapa
          </Button>
          <span className="text-sm text-slate-600">{f.latitude ? `${f.latitude}, ${f.longitude}` : 'Sem posição ainda'}</span>
        </div>
        <details className="rounded-lg border border-slate-200 p-3" open={!existente}>
          <summary className="cursor-pointer text-sm font-medium">Condições de moradia</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Field label="Tipo de imóvel" htmlFor="dom-imovel">
              <Select id="dom-imovel" value={f.propertyType} onChange={(e) => set('propertyType', e.target.value)}>
                {opt(TIPO_IMOVEL)}
              </Select>
            </Field>
            <Field label="Tipo de domicílio" htmlFor="dom-tipo">
              <Select id="dom-tipo" value={f.dwellingType} onChange={(e) => set('dwellingType', e.target.value)}>
                {opt(TIPO_DOMICILIO)}
              </Select>
            </Field>
            <Field label="Situação de moradia" htmlFor="dom-posse">
              <Select id="dom-posse" value={f.tenure} onChange={(e) => set('tenure', e.target.value)}>
                {opt(SITUACAO_MORADIA)}
              </Select>
            </Field>
            <Field label="Material das paredes" htmlFor="dom-parede">
              <Select id="dom-parede" value={f.wallMaterial} onChange={(e) => set('wallMaterial', e.target.value)}>
                {opt(MATERIAL_PAREDES)}
              </Select>
            </Field>
            <Field label="Abastecimento de água" htmlFor="dom-agua">
              <Select id="dom-agua" value={f.waterSupply} onChange={(e) => set('waterSupply', e.target.value)}>
                {opt(ABASTECIMENTO_AGUA)}
              </Select>
            </Field>
            <Field label="Tratamento da água" htmlFor="dom-trat">
              <Select id="dom-trat" value={f.waterTreatment} onChange={(e) => set('waterTreatment', e.target.value)}>
                {opt(TRATAMENTO_AGUA)}
              </Select>
            </Field>
            <Field label="Esgotamento sanitário" htmlFor="dom-esgoto">
              <Select id="dom-esgoto" value={f.sewage} onChange={(e) => set('sewage', e.target.value)}>
                {opt(ESGOTAMENTO)}
              </Select>
            </Field>
            <Field label="Destino do lixo" htmlFor="dom-lixo">
              <Select id="dom-lixo" value={f.garbage} onChange={(e) => set('garbage', e.target.value)}>
                {opt(DESTINO_LIXO)}
              </Select>
            </Field>
            <Field label="Energia elétrica" htmlFor="dom-energia">
              <Select id="dom-energia" value={f.electricity} onChange={(e) => set('electricity', e.target.value)}>
                <option value="">Não informado</option>
                <option value="true">Sim</option>
                <option value="false">Não</option>
              </Select>
            </Field>
            <Field label="Cômodos" htmlFor="dom-comodos">
              <Input id="dom-comodos" inputMode="numeric" value={f.rooms} onChange={(e) => set('rooms', e.target.value)} />
            </Field>
            <Field label="Animais no domicílio" htmlFor="dom-animais" className="sm:col-span-2">
              <Input id="dom-animais" value={f.animals} onChange={(e) => set('animals', e.target.value)} placeholder="cão, gato..." />
            </Field>
          </div>
        </details>
        {!existente && (
          <div className="rounded-lg border border-slate-200 p-3">
            <p className="mb-2 text-sm font-medium">Família e responsável</p>
            <div className="mb-3 flex flex-wrap gap-2">
              <label className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm ${responsavel === 'novo' ? 'border-brand-500 bg-brand-50 font-medium' : 'border-slate-200'}`}>
                <input type="radio" name="resp" checked={responsavel === 'novo'} onChange={() => setResponsavel('novo')} /> Cadastrar o responsável agora
              </label>
              <label className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm ${responsavel === 'depois' ? 'border-brand-500 bg-brand-50 font-medium' : 'border-slate-200'}`}>
                <input type="radio" name="resp" checked={responsavel === 'depois'} onChange={() => setResponsavel('depois')} /> Família sem responsável por enquanto
              </label>
            </div>
            <Field label="Renda familiar" htmlFor="dom-renda" className="mb-3">
              <Select id="dom-renda" value={renda} onChange={(e) => setRenda(e.target.value)}>
                {opt(RENDA_FAMILIAR, 'Não informada')}
              </Select>
            </Field>
            {responsavel === 'novo' && <PessoaCampos valor={pessoa} onChange={setPessoa} prefixo="resp" />}
          </div>
        )}
        <Field label="Observações" htmlFor="dom-obs">
          <Textarea id="dom-obs" rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
