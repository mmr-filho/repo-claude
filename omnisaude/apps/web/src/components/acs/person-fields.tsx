'use client';

import { ESCOLARIDADE, RACA_COR, type PessoaCampo } from '@omnisaude/shared';
import { Field, Input, Select } from '@/components/ui/input';

export type PessoaForm = Omit<PessoaCampo, 'endereco' | 'confirmarNaoDuplicado'> & { confirmarNaoDuplicado?: boolean | null };

export const pessoaVazia = (): PessoaForm => ({ name: '', birthDate: '', sex: 'F', cpf: '', cns: '', motherName: '', phone: '', racaCor: '', education: '', nis: '', bolsaFamilia: false, confirmarNaoDuplicado: false });

/** Campos do cadastro individual mínimo feito em campo (o restante é completado na unidade). */
export function PessoaCampos({ valor, onChange, prefixo }: { valor: PessoaForm; onChange: (v: PessoaForm) => void; prefixo: string }) {
  const set = <K extends keyof PessoaForm>(k: K, v: PessoaForm[K]) => onChange({ ...valor, [k]: v });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Nome completo" htmlFor={`${prefixo}-nome`} className="sm:col-span-2">
        <Input id={`${prefixo}-nome`} value={valor.name} onChange={(e) => set('name', e.target.value)} autoComplete="off" required />
      </Field>
      <Field label="Data de nascimento" htmlFor={`${prefixo}-nasc`}>
        <Input id={`${prefixo}-nasc`} type="date" value={valor.birthDate} onChange={(e) => set('birthDate', e.target.value)} required />
      </Field>
      <Field label="Sexo" htmlFor={`${prefixo}-sexo`}>
        <Select id={`${prefixo}-sexo`} value={valor.sex} onChange={(e) => set('sex', e.target.value as 'M' | 'F')}>
          <option value="F">Feminino</option>
          <option value="M">Masculino</option>
        </Select>
      </Field>
      <Field label="CPF" htmlFor={`${prefixo}-cpf`} hint="Sem CPF, informe o CNS">
        <Input id={`${prefixo}-cpf`} inputMode="numeric" value={valor.cpf ?? ''} onChange={(e) => set('cpf', e.target.value)} placeholder="000.000.000-00" />
      </Field>
      <Field label="CNS (cartão SUS)" htmlFor={`${prefixo}-cns`}>
        <Input id={`${prefixo}-cns`} inputMode="numeric" value={valor.cns ?? ''} onChange={(e) => set('cns', e.target.value)} placeholder="15 dígitos" />
      </Field>
      <Field label="Nome da mãe" htmlFor={`${prefixo}-mae`} className="sm:col-span-2">
        <Input id={`${prefixo}-mae`} value={valor.motherName ?? ''} onChange={(e) => set('motherName', e.target.value)} />
      </Field>
      <Field label="Telefone" htmlFor={`${prefixo}-tel`}>
        <Input id={`${prefixo}-tel`} inputMode="tel" value={valor.phone ?? ''} onChange={(e) => set('phone', e.target.value)} placeholder="(00) 00000-0000" />
      </Field>
      <Field label="Raça/cor" htmlFor={`${prefixo}-raca`}>
        <Select id={`${prefixo}-raca`} value={valor.racaCor ?? ''} onChange={(e) => set('racaCor', e.target.value || null)}>
          <option value="">Não informada</option>
          {Object.entries(RACA_COR).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Escolaridade" htmlFor={`${prefixo}-esc`}>
        <Select id={`${prefixo}-esc`} value={valor.education ?? ''} onChange={(e) => set('education', e.target.value || null)}>
          <option value="">Não informada</option>
          {Object.entries(ESCOLARIDADE).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="NIS (Bolsa Família)" htmlFor={`${prefixo}-nis`}>
        <Input id={`${prefixo}-nis`} inputMode="numeric" value={valor.nis ?? ''} onChange={(e) => set('nis', e.target.value)} />
      </Field>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" checked={!!valor.bolsaFamilia} onChange={(e) => set('bolsaFamilia', e.target.checked)} />
        Família beneficiária do Bolsa Família
      </label>
      <label className="flex items-center gap-2 text-sm text-slate-600 sm:col-span-2">
        <input type="checkbox" checked={!!valor.confirmarNaoDuplicado} onChange={(e) => set('confirmarNaoDuplicado', e.target.checked)} />
        Não é a mesma pessoa de um cadastro parecido (mesmo nome e nascimento)
      </label>
    </div>
  );
}

export function pessoaValida(p: PessoaForm): string | null {
  if (p.name.trim().split(/\s+/).length < 2) return 'Informe o nome completo (nome e sobrenome)';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.birthDate)) return 'Informe a data de nascimento';
  if (new Date(`${p.birthDate}T12:00:00Z`).getTime() > Date.now()) return 'Data de nascimento no futuro';
  return null;
}

export function pessoaParaOp(p: PessoaForm, endereco: PessoaCampo['endereco']): PessoaCampo {
  const limpa = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);
  return {
    name: p.name.trim(),
    birthDate: p.birthDate,
    sex: p.sex,
    cpf: limpa(p.cpf),
    cns: limpa(p.cns),
    motherName: limpa(p.motherName),
    phone: limpa(p.phone),
    racaCor: limpa(p.racaCor),
    education: limpa(p.education),
    nis: limpa(p.nis),
    bolsaFamilia: !!p.bolsaFamilia,
    endereco: endereco ?? null,
    confirmarNaoDuplicado: !!p.confirmarNaoDuplicado,
  };
}
