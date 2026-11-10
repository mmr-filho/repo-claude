'use client';

import {
  descreverReceita,
  RECEITAS_MODELO,
  ROTULO_BASE_CANAL,
  ROTULO_BORDA_CANAL,
  ROTULO_JANELA_CANAL,
  ROTULO_METODO_CANAL,
  ROTULO_UNIDADE_CANAL,
  type ChaveReceitaModelo,
  type ConfiguracaoDiagrama,
  type ListaPopulacao,
  type ReceitaCanal,
  type RespostaAnosEpidemicos,
} from '@omnisaude/shared';
import { Plus, Sparkles, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { textoFonte } from './diagrama-dados';
import { ajustarReceita, aplicarModelo, CHAVES_MODELO, corpoDaReceita, formularioDaConfiguracao, janelasDoMetodo, MOTIVO_MINIMO_EXCLUSAO, motivoSugerido, type FormularioReceita } from './diagrama-receita-regras';
import { opcoesDeFonte, valorDaFonte } from './populacao-colar';

/** Mensagens do erro da API: a lista de problemas da configuração, quando vem, ou a mensagem. */
function mensagensDoErro(err: unknown): string[] {
  const details = (err as { details?: unknown })?.details;
  if (Array.isArray(details) && details.length && details.every((d) => typeof d === 'string')) return details as string[];
  return [errorMessage(err)];
}

/** Ajustes da receita (método, quartil, k, anos, janela, borda, unidade, base e as marcas do ano em análise). */
function CamposDaReceita({ receita, onChange }: { receita: ReceitaCanal; onChange: (r: ReceitaCanal) => void }) {
  const set = <K extends keyof ReceitaCanal>(campo: K, valor: ReceitaCanal[K]) => onChange(ajustarReceita(receita, campo, valor));
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Método" htmlFor="rc-metodo">
        <Select id="rc-metodo" value={receita.metodo} onChange={(e) => set('metodo', e.target.value as ReceitaCanal['metodo'])}>
          {(Object.keys(ROTULO_METODO_CANAL) as ReceitaCanal['metodo'][]).map((m) => (
            <option key={m} value={m}>
              {ROTULO_METODO_CANAL[m]}
            </option>
          ))}
        </Select>
      </Field>
      {receita.metodo === 'QUARTIS' ? (
        <Field label="Função de quartil" htmlFor="rc-quartil" hint="O MS usa a QUARTIL.EXC">
          <Select id="rc-quartil" value={receita.quartil} onChange={(e) => set('quartil', e.target.value as ReceitaCanal['quartil'])}>
            <option value="EXC">QUARTIL.EXC</option>
            <option value="INC">QUARTIL.INC</option>
          </Select>
        </Field>
      ) : (
        <Field label="Multiplicador do DP (k)" htmlFor="rc-k" hint="1,96 nas Diretrizes 2009">
          <Input id="rc-k" type="number" min={0.1} max={5} step={0.01} value={receita.k} onChange={(e) => set('k', Number(e.target.value))} />
        </Field>
      )}
      <Field label="Anos de referência" htmlFor="rc-anos" hint="Anteriores ao ano em análise">
        <Input id="rc-anos" type="number" min={1} max={20} step={1} value={receita.anos} onChange={(e) => set('anos', Math.trunc(Number(e.target.value)))} />
      </Field>
      <Field label="Janela" htmlFor="rc-janela">
        <Select id="rc-janela" value={receita.janela} onChange={(e) => set('janela', e.target.value as ReceitaCanal['janela'])}>
          {janelasDoMetodo(receita.metodo).map((j) => (
            <option key={j} value={j}>
              {ROTULO_JANELA_CANAL[j]}
            </option>
          ))}
        </Select>
      </Field>
      {receita.janela !== 'NENHUMA' && (
        <Field label="Borda da janela" htmlFor="rc-borda" className="sm:col-span-2">
          <Select id="rc-borda" value={receita.borda} onChange={(e) => set('borda', e.target.value as ReceitaCanal['borda'])}>
            {(Object.keys(ROTULO_BORDA_CANAL) as ReceitaCanal['borda'][]).map((b) => (
              <option key={b} value={b}>
                {ROTULO_BORDA_CANAL[b]}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label="Unidade" htmlFor="rc-unidade">
        <Select id="rc-unidade" value={receita.unidade} onChange={(e) => set('unidade', e.target.value as ReceitaCanal['unidade'])}>
          {(Object.keys(ROTULO_UNIDADE_CANAL) as ReceitaCanal['unidade'][]).map((u) => (
            <option key={u} value={u}>
              {ROTULO_UNIDADE_CANAL[u]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Casos da série" htmlFor="rc-base">
        <Select id="rc-base" value={receita.base} onChange={(e) => set('base', e.target.value as ReceitaCanal['base'])}>
          {(Object.keys(ROTULO_BASE_CANAL) as ReceitaCanal['base'][]).map((b) => (
            <option key={b} value={b}>
              {ROTULO_BASE_CANAL[b]}
            </option>
          ))}
        </Select>
      </Field>
      <label className="flex items-start gap-2 text-sm sm:col-span-2">
        <input type="checkbox" className="mt-1" checked={receita.anoEmAnaliseTodosNotificados} onChange={(e) => set('anoEmAnaliseTodosNotificados', e.target.checked)} />
        No ano em análise, todos os notificados (Diretrizes 2009)
      </label>
      <label className="flex items-start gap-2 text-sm sm:col-span-2">
        <input type="checkbox" className="mt-1" checked={receita.incluiAnoEmAnalise} onChange={(e) => set('incluiAnoEmAnalise', e.target.checked)} />O ano em análise entra na referência (só para reproduzir a Tabela 1 da
        NT 1/2023)
      </label>
    </div>
  );
}

/** Anos epidêmicos sugeridos pela regra da SES-GO; a exclusão é decisão da vigilância, com motivo. */
function AnosEpidemicos({ grupo, ano, form, onExcluir }: { grupo: string; ano: number; form: FormularioReceita | null; onExcluir: (ano: number, motivo: string) => void }) {
  const [pedido, setPedido] = useState(false);
  const r = useApi<RespostaAnosEpidemicos>(pedido ? `/vigilancia/diagrama/anos-epidemicos?grupo=${encodeURIComponent(grupo)}&ano=${ano}` : null, [grupo, ano]);
  const jaExcluidos = new Set((form?.anosExcluidos ?? []).map((a) => Number(a.ano)));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" size="sm" onClick={() => (pedido ? void r.reload() : setPedido(true))} loading={r.loading && pedido}>
          <Sparkles className="h-4 w-4" /> Sugerir anos epidêmicos
        </Button>
        <span className="text-xs text-slate-500">Usa a receita gravada e a série do município antes de {ano}. Só sugere.</span>
      </div>
      {r.error && <Alert tone="error">{r.error}</Alert>}
      {r.data && (
        <>
          <Table>
            <THead>
              <tr>
                <TH>Ano</TH>
                <TH className="text-right">SE acima de média + 1 DP</TH>
                <TH>Sugestão</TH>
                {form && <TH />}
              </tr>
            </THead>
            <TBody>
              {r.data.sugestao.anos.map((a) => (
                <TR key={a.ano}>
                  <TD className="tabular-nums">{a.ano}</TD>
                  <TD className="text-right tabular-nums">{a.semanasAcima}</TD>
                  <TD>{a.epidemico ? <Badge tone="amber">Epidêmico</Badge> : <span className="text-xs text-slate-500">Não epidêmico</span>}</TD>
                  {form && (
                    <TD className="text-right">
                      {a.epidemico && !jaExcluidos.has(a.ano) && (
                        <Button size="sm" variant="ghost" onClick={() => onExcluir(a.ano, motivoSugerido(a.semanasAcima))}>
                          Excluir {a.ano}
                        </Button>
                      )}
                      {jaExcluidos.has(a.ano) && <span className="text-xs text-slate-500">Na lista de excluídos</span>}
                    </TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
          <p className="text-xs text-slate-500">
            {r.data.sugestao.limiar !== null ? `Limiar (Q3 das contagens): ${r.data.sugestao.limiar.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}. ` : 'Menos de 3 anos com dados: sem limiar. '}
            {r.data.sugestao.nota}
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Receita do canal do agravo: modelo publicado (MS 2025, NT 1/2023, VigiEPI 2025, Diretrizes 2009), ajustes, anos
 * excluídos com motivo e a fonte da população. Leitura para todos da aba; gravação com `vigilancia.consolidacao`.
 */
export function DiagramaReceita({
  grupo,
  nomeAgravo,
  ano,
  anoAtual,
  configuracao,
  podeConfigurar,
  onSalvo,
}: {
  grupo: string;
  nomeAgravo: string;
  ano: number;
  anoAtual: number;
  configuracao: ConfiguracaoDiagrama | null;
  podeConfigurar: boolean;
  onSalvo: () => void;
}) {
  const toast = useToast();
  const lida = useApi<ConfiguracaoDiagrama>(configuracao ? null : `/vigilancia/diagrama/configuracao/${encodeURIComponent(grupo)}`, [grupo]);
  const config = configuracao ?? lida.data;
  const municipio = useApi<ListaPopulacao>(podeConfigurar ? '/vigilancia/populacao?nivel=MUNICIPIO' : null);
  const [form, setForm] = useState<FormularioReceita | null>(null);
  const [erros, setErros] = useState<string[]>([]);
  const [gravando, setGravando] = useState(false);

  if (!config) return lida.error ? <Alert tone="error">{lida.error}</Alert> : <Spinner />;
  const modelo = config.modelo ? RECEITAS_MODELO[config.modelo] : null;
  const fontes = opcoesDeFonte(municipio.data ?? [], { fonte: config.fontePopulacao, versao: config.versaoPopulacao });
  const modeloDoForm = form?.modelo ? RECEITAS_MODELO[form.modelo] : null;

  async function gravar() {
    if (!form) return;
    const { corpo, erros: problemas } = corpoDaReceita(form, anoAtual);
    setErros(problemas);
    if (!corpo) return;
    setGravando(true);
    try {
      await api.put(`/vigilancia/diagrama/configuracao/${encodeURIComponent(grupo)}`, { ...corpo });
      toast.success('Receita gravada. O canal congelado só muda quando for congelado de novo.');
      setForm(null);
      setErros([]);
      if (!configuracao) void lida.reload();
      onSalvo();
    } catch (err) {
      setErros(mensagensDoErro(err));
    } finally {
      setGravando(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={`Receita do canal: ${nomeAgravo}`}
          description={
            config.padrao
              ? 'Sem receita gravada: vale o modelo do Plano de Contingência Nacional (MS, 2025).'
              : `Gravada em ${fmtDateTime(config.atualizadoEm)}${config.atualizadoPor ? ` por ${config.atualizadoPor}` : ''}.`
          }
          actions={
            podeConfigurar && !form ? (
              <Button size="sm" variant="secondary" onClick={() => setForm(formularioDaConfiguracao(config))}>
                Editar a receita
              </Button>
            ) : undefined
          }
        />
        <CardBody className="space-y-3 text-sm">
          <p>
            <span className="font-medium text-slate-900">{modelo ? modelo.nome : 'Receita própria'}</span>
            {config.padrao && (
              <Badge tone="slate" className="ml-2">
                Padrão
              </Badge>
            )}
          </p>
          <p className="text-slate-700">{descreverReceita(config.receita)}.</p>
          {modelo && (
            <p className="text-xs text-slate-500">
              {modelo.nota} Fonte: {modelo.fonte}.
            </p>
          )}
          <p className="text-slate-700">
            <span className="font-medium">População:</span> {config.fontePopulacao ? textoFonte(config.fontePopulacao, config.versaoPopulacao) : 'escolhida pelo sistema (a mesma fonte e versão em todos os anos)'}
            {config.receita.unidade === 'CASOS' ? ' (não usada: a receita é em número de casos)' : ''}
          </p>
          <div>
            <p className="font-medium text-slate-700">Anos excluídos da referência</p>
            {config.anosExcluidos.length ? (
              <ul className="mt-1 list-inside list-disc text-slate-700">
                {config.anosExcluidos.map((a) => (
                  <li key={a.ano}>
                    <span className="tabular-nums">{a.ano}</span>: {a.motivo}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-slate-500">Nenhum.</p>
            )}
          </div>
        </CardBody>
      </Card>

      {form && (
        <Card>
          <CardHeader title="Editar a receita" description="Parta de um modelo publicado e ajuste só o que a vigilância decidiu. Cada canal congelado guarda a receita com que foi calculado." />
          <CardBody className="space-y-4">
            <Field label="Modelo" htmlFor="rc-modelo">
              <Select id="rc-modelo" value={form.modelo ?? ''} onChange={(e) => setForm(aplicarModelo(form, (e.target.value || null) as ChaveReceitaModelo | null))}>
                {CHAVES_MODELO.map((m) => (
                  <option key={m} value={m}>
                    {RECEITAS_MODELO[m].nome}
                  </option>
                ))}
                <option value="">Receita própria (ajustes à mão)</option>
              </Select>
            </Field>
            {modeloDoForm && (
              <Alert tone="info">
                {modeloDoForm.nota} <span className="text-xs">Fonte: {modeloDoForm.fonte}.</span>
              </Alert>
            )}
            <CamposDaReceita receita={form.receita} onChange={(receita) => setForm({ ...form, receita })} />
            <p className="text-xs text-slate-500">Como fica: {descreverReceita(form.receita)}.</p>

            <Field label="Fonte da população" htmlFor="rc-fonte" hint="A incidência de cada ano usa a população daquele ano, da mesma fonte e versão em todos os anos.">
              <Select id="rc-fonte" value={form.fonte} onChange={(e) => setForm({ ...form, fonte: e.target.value })}>
                <option value="">Escolhida pelo sistema</option>
                {fontes.map((f) => (
                  <option key={valorDaFonte(f)} value={valorDaFonte(f)}>
                    {f.rotulo}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="space-y-2">
              <p className="text-sm font-medium text-slate-700">Anos excluídos da referência (motivo com pelo menos {MOTIVO_MINIMO_EXCLUSAO} caracteres)</p>
              {form.anosExcluidos.map((a, i) => (
                <div key={i} className="flex flex-wrap items-end gap-2">
                  <Field label="Ano" htmlFor={`rc-ex-ano-${i}`} className="w-28">
                    <Input id={`rc-ex-ano-${i}`} inputMode="numeric" value={a.ano} onChange={(e) => setForm({ ...form, anosExcluidos: form.anosExcluidos.map((x, j) => (j === i ? { ...x, ano: e.target.value } : x)) })} />
                  </Field>
                  <Field label="Motivo" htmlFor={`rc-ex-motivo-${i}`} className="min-w-64 flex-1">
                    <Input
                      id={`rc-ex-motivo-${i}`}
                      value={a.motivo}
                      maxLength={500}
                      onChange={(e) => setForm({ ...form, anosExcluidos: form.anosExcluidos.map((x, j) => (j === i ? { ...x, motivo: e.target.value } : x)) })}
                    />
                  </Field>
                  <Button variant="ghost" size="icon" aria-label={`Tirar ${a.ano || 'o ano'} dos excluídos`} onClick={() => setForm({ ...form, anosExcluidos: form.anosExcluidos.filter((_, j) => j !== i) })}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button size="sm" variant="secondary" onClick={() => setForm({ ...form, anosExcluidos: [...form.anosExcluidos, { ano: '', motivo: '' }] })}>
                <Plus className="h-4 w-4" /> Acrescentar ano
              </Button>
            </div>

            {erros.length > 0 && (
              <Alert tone="error" title="Não deu para gravar">
                <ul className="list-inside list-disc">
                  {erros.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </Alert>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setForm(null);
                  setErros([]);
                }}
              >
                Cancelar
              </Button>
              <Button onClick={gravar} loading={gravando}>
                Gravar a receita
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="Anos epidêmicos" description="Regra do painel da SES-GO: em quantas SE cada ano passou da média móvel + 1 DP; são epidêmicos os anos com contagem no Q3 ou acima." />
        <CardBody>
          <AnosEpidemicos
            grupo={grupo}
            ano={ano}
            form={form}
            onExcluir={(a, motivo) => form && setForm({ ...form, anosExcluidos: [...form.anosExcluidos.filter((x) => Number(x.ano) !== a), { ano: String(a), motivo }] })}
          />
          {podeConfigurar && !form && <p className="mt-2 text-xs text-slate-500">Para excluir um ano sugerido, abra &quot;Editar a receita&quot;.</p>}
        </CardBody>
      </Card>
    </div>
  );
}
