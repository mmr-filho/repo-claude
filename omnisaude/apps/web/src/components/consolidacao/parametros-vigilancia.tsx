'use client';

import { Save, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { corpoParametros, DIAS_DA_SEMANA, errosParametros, formParametros, LIMITES_PARAMETROS, textoDoPrazo, type ConfiguracoesDaVigilancia, type FormParametros } from './parametros-regras';

function CampoInteiro({ campo, f, set, dica }: { campo: keyof typeof LIMITES_PARAMETROS; f: FormParametros; set: (p: Partial<FormParametros>) => void; dica: string }) {
  const l = LIMITES_PARAMETROS[campo];
  return (
    <Field label={l.rotulo} htmlFor={`par-${campo}`} hint={`${dica} De ${l.min.toLocaleString('pt-BR')} a ${l.max.toLocaleString('pt-BR')}.`}>
      <Input id={`par-${campo}`} type="number" inputMode="numeric" min={l.min} max={l.max} step={1} value={f[campo]} onChange={(e) => set({ [campo]: e.target.value })} />
    </Field>
  );
}

/**
 * Parâmetros da semana 27 (vigilância municipal, `vigilancia.catalogo`): prazo do atesto da negativa, meta e janelas da
 * grade, semanas incompletas e validade da prévia da importação, e os dias sem caso do evento inusitado. Grava só o que
 * mudou (PATCH /vigilancia/configuracoes); fica na auditoria.
 */
export function ParametrosVigilancia() {
  const toast = useToast();
  const cfg = useApi<ConfiguracoesDaVigilancia>('/vigilancia/configuracoes');
  const [form, setForm] = useState<FormParametros | null>(null);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  if (!cfg.data) return cfg.error ? <Alert tone="error">{cfg.error}</Alert> : <Spinner />;
  const c = cfg.data;
  const f = form ?? formParametros(c);
  const set = (patch: Partial<FormParametros>) => setForm({ ...f, ...patch });
  const erros = errosParametros(f);
  const corpo = corpoParametros(c, f);
  const prazo = textoDoPrazo(f);

  async function salvar() {
    if (!corpo) return;
    setBusy(true);
    setErro(null);
    try {
      const nova = await api.patch<ConfiguracoesDaVigilancia>('/vigilancia/configuracoes', { ...corpo });
      cfg.setData({ ...c, ...nova });
      setForm(null);
      toast.success('Parâmetros gravados.');
    } catch (err) {
      setErro(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Notificação negativa" description="Prazo do atesto e parâmetros da grade. Não há prazo federal: use o pactuado com a SES (ex.: segunda-feira até 14:00)." />
        <CardBody className="grid gap-3 pt-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Dia do prazo" htmlFor="par-prazoDiaSemana" hint="Na semana seguinte à SE atestada.">
            <Select id="par-prazoDiaSemana" value={f.prazoDiaSemana} onChange={(e) => set({ prazoDiaSemana: e.target.value })}>
              {DIAS_DA_SEMANA.map((d, i) => (
                <option key={d} value={String(i)}>
                  {d}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Hora do prazo" htmlFor="par-prazoHora" hint="HH:MM, no fuso da instituição.">
            <Input id="par-prazoHora" type="time" value={f.prazoHora} onChange={(e) => set({ prazoHora: e.target.value })} />
          </Field>
          <CampoInteiro campo="metaPercentual" f={f} set={set} dica="Referência da PFA: 80%." />
          <CampoInteiro campo="semanasAtesto" f={f} set={set} dica="Semanas fechadas que o responsável ainda atesta." />
          <CampoInteiro campo="semanasSilenciosa" f={f} set={set} dica="Semanas fechadas seguidas sem informação." />
          <CampoInteiro campo="semanasSoNegativa" f={f} set={set} dica="Semanas fechadas só com negativa." />
          <CampoInteiro campo="semanasRegularidadeMunicipal" f={f} set={set} dica="Sem nenhuma informação no município (PRC nº 6/2017, art. 454-E: 8)." />
          <label className="flex items-start gap-2 self-center text-sm text-slate-700">
            <input type="checkbox" className="mt-0.5" checked={f.contaAtrasada} onChange={(e) => set({ contaAtrasada: e.target.checked })} />O atesto fora do prazo conta como informação no percentual da semana
          </label>
          {prazo && <p className="text-xs text-slate-600 sm:col-span-2 lg:col-span-4">Prazo do atesto: {prazo}.</p>}
        </CardBody>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Consolidação e diagrama" description="Atraso de notificação e validade da prévia da importação." />
          <CardBody className="grid gap-3 pt-4 sm:grid-cols-2">
            <CampoInteiro campo="semanasIncompletas" f={f} set={set} dica="As mais recentes, contando a em curso, ficam incompletas (fora da avaliação)." />
            <CampoInteiro campo="expiraPreviaHoras" f={f} set={set} dica="A prévia não aplicada é descartada depois disso." />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Sugestões de surto" description="As regras de sugestão não se editam por aqui." />
          <CardBody className="pt-4">
            <CampoInteiro campo="diasInusitado" f={f} set={set} dica="Sem caso do agravo nesse tempo, o primeiro caso vira evento inusitado." />
          </CardBody>
        </Card>
      </div>
      <Card>
        <CardBody className="space-y-3">
          {erros.length > 0 && (
            <Alert tone="warn" title="Corrija antes de gravar">
              <ul className="list-inside list-disc space-y-0.5">
                {erros.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </Alert>
          )}
          {erro && <Alert tone="error">{erro}</Alert>}
          <div className="flex flex-wrap justify-end gap-2">
            {form && (
              <Button variant="ghost" onClick={() => setForm(null)}>
                <Undo2 className="h-4 w-4" /> Desfazer alterações
              </Button>
            )}
            <Button onClick={salvar} disabled={!corpo} loading={busy}>
              <Save className="h-4 w-4" /> Gravar os parâmetros
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
