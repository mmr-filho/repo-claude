'use client';

import {
  ATIVIDADE_INFO,
  ATIVIDADES_VETORIAIS,
  avaliarGps,
  conferirVisitaVetorial,
  DEPOSITO_INFO,
  LOCAL_UBV_LABEL,
  LOCAIS_UBV,
  SITUACAO_INFO,
  SITUACOES_VISITA,
  TIPOS_DEPOSITO,
  totaisDepositos,
  type AmostraCampo,
  type AtividadeVetorial,
  type ContagemDeposito,
  type Depositos,
  type LocalUbv,
  type OperacaoAce,
  type SituacaoVisita,
  type TipoDeposito,
  type TratamentoCampo,
} from '@omnisaude/shared';
import { LocateFixed, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { local, obterPosicao, uuid, type Posicao } from '@/lib/offline';
import type { ImovelCampoView, LoteCampo } from './types';

const agoraLocal = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

const vazio: ContagemDeposito = { inspecionados: 0, comFoco: 0, eliminados: 0, tratados: 0 };
/** "1,5" ou "1.5" → 1,5; vazio ou inválido → 0 (a conferência pede quantidade maior que zero). */
const paraNumero = (texto: string) => {
  const n = Number(texto.trim().replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const COLUNAS: { chave: keyof ContagemDeposito; rotulo: string }[] = [
  { chave: 'inspecionados', rotulo: 'Inspec.' },
  { chave: 'comFoco', rotulo: 'Com foco' },
  { chave: 'eliminados', rotulo: 'Elimin.' },
  { chave: 'tratados', rotulo: 'Tratados' },
];

/** Último número de tubito usado pelo agente (cada ACE numera de 1 a 999 e recomeça). */
const chaveTubito = (userId: string) => `tubito:${userId}`;

export interface ContextoVisita {
  imovel: ImovelCampoView;
  /** Ordem de bloqueio que inclui o quarteirão do imóvel (a visita entra nela). */
  ordem: { id: string; numero: string } | null;
  quarteirao: string | null;
}

/**
 * Boletim de campo de uma visita do ACE: situação do imóvel, depósitos por tipo (A1 a E), tubitos coletados, larvicida
 * usado (produto, lote e quantidade, baixados do depósito de endemias), nebulização no bloqueio e GPS. Conferido no
 * aparelho com as mesmas regras da API antes de entrar na fila.
 */
export function VisitaVetorialForm({
  aberto,
  onClose,
  contexto,
  estoque,
  userId,
  usoNaFila,
  onSalvar,
}: {
  aberto: boolean;
  onClose: () => void;
  contexto: ContextoVisita | null;
  estoque: LoteCampo[];
  userId: string;
  /** Quantidade já usada por lote nas visitas que ainda estão na fila (só para avisar, nunca bloqueia). */
  usoNaFila: Map<string, number>;
  onSalvar: (op: OperacaoAce, rotulo: string) => Promise<void>;
}) {
  const imovel = contexto?.imovel ?? null;
  const [atividade, setAtividade] = useState<AtividadeVetorial>('LI_T');
  const [situacao, setSituacao] = useState<SituacaoVisita>('TRABALHADO');
  const [depositos, setDepositos] = useState<Partial<Record<TipoDeposito, ContagemDeposito>>>({});
  const [amostras, setAmostras] = useState<AmostraCampo[]>([]);
  // O texto da quantidade fica como digitado ("1," a caminho de "1,5"); o número sai dele ao salvar.
  const [tratamentos, setTratamentos] = useState<(TratamentoCampo & { chave: string; qtdTexto: string })[]>([]);
  const [ubv, setUbv] = useState<LocalUbv | ''>('');
  const [educativa, setEducativa] = useState(true);
  const [obs, setObs] = useState('');
  const [quando, setQuando] = useState(agoraLocal());
  const [posicao, setPosicao] = useState<Posicao | null>(null);
  const [localizando, setLocalizando] = useState(false);
  const [erroGps, setErroGps] = useState<string | null>(null);
  const [erros, setErros] = useState<string[]>([]);
  const [salvando, setSalvando] = useState(false);
  const [proximoTubito, setProximoTubito] = useState(1);

  useEffect(() => {
    if (!aberto) return;
    setAtividade(contexto?.ordem ? 'BLOQUEIO' : 'LI_T');
    setSituacao('TRABALHADO');
    setDepositos({});
    setAmostras([]);
    setTratamentos([]);
    setUbv('');
    setEducativa(true);
    setObs('');
    setQuando(agoraLocal());
    setPosicao(null);
    setErroGps(null);
    setErros([]);
    void local.get<{ key: string; data: number }>('cache', chaveTubito(userId)).then((r) => setProximoTubito(((r?.data ?? 0) % 999) + 1));
  }, [aberto, contexto, userId]);

  const pendente = SITUACAO_INFO[situacao].pendencia;
  const totais = totaisDepositos(depositos);
  const ehPe = imovel?.tipo === '04';
  const produtos = useMemo(() => {
    const m = new Map<string, { id: string; nome: string; unidade: string; lotes: LoteCampo[] }>();
    for (const l of estoque) {
      const p = m.get(l.produtoId) ?? { id: l.produtoId, nome: l.produto, unidade: l.unidade, lotes: [] };
      p.lotes.push(l);
      m.set(l.produtoId, p);
    }
    return [...m.values()];
  }, [estoque]);

  const mudar = (tipo: TipoDeposito, chave: keyof ContagemDeposito, valor: string) => {
    const n = Math.max(0, Math.min(999, Number(valor.replace(/\D/g, '')) || 0));
    setDepositos((d) => ({ ...d, [tipo]: { ...(d[tipo] ?? vazio), [chave]: n } }));
  };

  // Depósitos tratados na tabela puxam uma linha de larvicida (o mais próximo de vencer primeiro).
  useEffect(() => {
    if (pendente || totais.tratados === 0 || tratamentos.length || !produtos.length) return;
    const p = produtos[0]!;
    setTratamentos([{ chave: uuid(), produtoId: p.id, loteId: p.lotes.find((l) => !l.vencido)?.loteId ?? p.lotes[0]!.loteId, quantidade: 0, qtdTexto: '', depositos: totais.tratados }]);
  }, [pendente, totais.tratados, tratamentos.length, produtos]);

  const localizar = async () => {
    setLocalizando(true);
    setErroGps(null);
    try {
      setPosicao(await obterPosicao());
    } catch (e) {
      setErroGps(e instanceof Error ? e.message : String(e));
    } finally {
      setLocalizando(false);
    }
  };

  const salvar = async () => {
    if (!imovel) return;
    const visita = {
      atividade,
      situacao,
      ordemId: contexto?.ordem?.id ?? null,
      ...(pendente
        ? {}
        : {
            depositos: Object.fromEntries(Object.entries(depositos).filter(([, c]) => c && (c.inspecionados || c.comFoco || c.eliminados || c.tratados))) as Depositos,
            amostras,
            tratamentos: tratamentos.map(({ chave: _c, qtdTexto, ...t }) => ({ ...t, quantidade: paraNumero(qtdTexto) })),
            ubv: atividade === 'BLOQUEIO' && ubv ? ubv : null,
            acaoEducativa: educativa,
          }),
      latitude: posicao?.latitude ?? null,
      longitude: posicao?.longitude ?? null,
      precisaoGps: posicao?.precisao ?? null,
      observacoes: obs.trim() || null,
    };
    const problemas = conferirVisitaVetorial(visita, { pontoEstrategico: ehPe });
    if (!quando || Number.isNaN(new Date(quando).getTime())) problemas.push('Informe a data e a hora da visita');
    else if (new Date(quando).getTime() > Date.now() + 5 * 60_000) problemas.push('A data da visita não pode estar no futuro');
    setErros(problemas);
    if (problemas.length) return;
    setSalvando(true);
    try {
      const op: OperacaoAce = imovel.pendente
        ? { tipo: 'VISITA_VETORIAL', clientId: uuid(), registradoEm: new Date(quando).toISOString(), householdClientId: imovel.id, visita }
        : { tipo: 'VISITA_VETORIAL', clientId: uuid(), registradoEm: new Date(quando).toISOString(), householdId: imovel.id, visita };
      if (amostras.length) await local.put('cache', { key: chaveTubito(userId), data: Math.max(...amostras.map((a) => a.numero)), savedAt: new Date().toISOString() });
      await onSalvar(op, `${SITUACAO_INFO[situacao].label} · ${contexto?.quarteirao ? `Q ${contexto.quarteirao} · ` : ''}${imovel.endereco}`);
      onClose();
    } finally {
      setSalvando(false);
    }
  };

  return (
    <Dialog
      open={aberto}
      onOpenChange={(o) => !o && onClose()}
      title="Visita ao imóvel"
      description={imovel ? `${contexto?.quarteirao ? `Quarteirão ${contexto.quarteirao} · ` : ''}${imovel.sequencia ? `seq. ${imovel.sequencia} · ` : ''}${imovel.endereco} · ${imovel.tipoLabel}` : undefined}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={salvar} loading={salvando}>
            Salvar no aparelho
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {contexto?.ordem && <Alert tone="info">Faz parte da ordem de bloqueio {contexto.ordem.numero}.</Alert>}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Atividade" htmlFor="vv-atividade">
            <Select id="vv-atividade" value={atividade} onChange={(e) => setAtividade(e.target.value as AtividadeVetorial)}>
              {ATIVIDADES_VETORIAIS.map((a) => (
                <option key={a} value={a}>
                  {ATIVIDADE_INFO[a].sigla} · {ATIVIDADE_INFO[a].label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Data e hora" htmlFor="vv-quando">
            <Input id="vv-quando" type="datetime-local" value={quando} onChange={(e) => setQuando(e.target.value)} />
          </Field>
        </div>
        <fieldset>
          <legend className="mb-1 text-sm font-medium text-slate-700">Situação do imóvel</legend>
          <div className="flex flex-wrap gap-2" role="radiogroup">
            {SITUACOES_VISITA.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={situacao === s}
                onClick={() => setSituacao(s)}
                className={cn('rounded-full border px-3 py-1.5 text-sm', situacao === s ? 'border-brand-600 bg-brand-50 font-medium text-brand-800' : 'border-slate-300 text-slate-700 hover:bg-slate-50')}
              >
                {SITUACAO_INFO[s].label}
              </button>
            ))}
          </div>
          {pendente && <p className="mt-1 text-xs text-slate-500">Pendência: o imóvel volta para a lista para recuperar em outro dia e turno.</p>}
        </fieldset>

        {!pendente && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[30rem] text-sm" aria-label="Depósitos">
                <thead className="text-left text-xs uppercase text-slate-500">
                  <tr>
                    <th className="py-1 pr-2">Depósito</th>
                    {COLUNAS.map((c) => (
                      <th key={c.chave} className="px-1 py-1">
                        {c.rotulo}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {TIPOS_DEPOSITO.map((t) => (
                    <tr key={t} className="border-t border-slate-100">
                      <td className="py-1 pr-2" title={DEPOSITO_INFO[t].descricao}>
                        <span className="font-semibold">{t}</span> <span className="text-xs text-slate-500">{DEPOSITO_INFO[t].grupo}</span>
                        {DEPOSITO_INFO[t].tratamento === 'NAO_TRATAR' && <span className="ml-1 text-xs text-amber-700">não tratar</span>}
                      </td>
                      {COLUNAS.map((c) => (
                        <td key={c.chave} className="px-1 py-1">
                          <Input
                            aria-label={`${t} ${c.rotulo}`}
                            inputMode="numeric"
                            className="h-9 w-16 text-center"
                            value={depositos[t]?.[c.chave] ? String(depositos[t]![c.chave]) : ''}
                            onChange={(e) => mudar(t, c.chave, e.target.value)}
                            disabled={c.chave === 'tratados' && (DEPOSITO_INFO[t].tratamento === 'NAO_TRATAR' || (DEPOSITO_INFO[t].tratamento === 'SO_PONTO_ESTRATEGICO' && !ehPe))}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                  <tr className="border-t border-slate-200 font-medium">
                    <td className="py-1 pr-2">Total</td>
                    <td className="px-1 text-center">{totais.inspecionados}</td>
                    <td className="px-1 text-center">{totais.comFoco}</td>
                    <td className="px-1 text-center">{totais.eliminados}</td>
                    <td className="px-1 text-center">{totais.tratados}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {totais.comFoco > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-700">Tubitos coletados (um por depósito com foco)</span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      const usados = new Set(amostras.map((a) => a.numero));
                      let n = proximoTubito;
                      while (usados.has(n)) n = (n % 999) + 1;
                      const tipo = TIPOS_DEPOSITO.find((t) => (depositos[t]?.comFoco ?? 0) > amostras.filter((a) => a.deposito === t).length) ?? 'C';
                      setAmostras([...amostras, { numero: n, deposito: tipo }]);
                      setProximoTubito((n % 999) + 1);
                    }}
                  >
                    <Plus className="mr-1 h-4 w-4" /> Tubito
                  </Button>
                </div>
                {amostras.map((a, i) => (
                  <div key={i} className="flex flex-wrap items-end gap-2">
                    <Field label="Nº" htmlFor={`vv-tubo-${i}`}>
                      <Input
                        id={`vv-tubo-${i}`}
                        inputMode="numeric"
                        className="w-20"
                        value={a.numero}
                        onChange={(e) => setAmostras(amostras.map((x, j) => (j === i ? { ...x, numero: Number(e.target.value.replace(/\D/g, '')) || 0 } : x)))}
                      />
                    </Field>
                    <Field label="Depósito" htmlFor={`vv-tubo-dep-${i}`}>
                      <Select id={`vv-tubo-dep-${i}`} value={a.deposito} onChange={(e) => setAmostras(amostras.map((x, j) => (j === i ? { ...x, deposito: e.target.value as TipoDeposito } : x)))}>
                        {TIPOS_DEPOSITO.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Larvas" htmlFor={`vv-tubo-lv-${i}`}>
                      <Input
                        id={`vv-tubo-lv-${i}`}
                        inputMode="numeric"
                        className="w-20"
                        value={a.larvas ?? ''}
                        onChange={(e) => setAmostras(amostras.map((x, j) => (j === i ? { ...x, larvas: e.target.value ? Number(e.target.value.replace(/\D/g, '')) : null } : x)))}
                      />
                    </Field>
                    <Button size="icon" variant="ghost" aria-label="Remover tubito" onClick={() => setAmostras(amostras.filter((_, j) => j !== i))}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {(totais.tratados > 0 || tratamentos.length > 0) && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-700">Larvicida usado</span>
                  {produtos.length > 0 && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setTratamentos([...tratamentos, { chave: uuid(), produtoId: produtos[0]!.id, loteId: produtos[0]!.lotes[0]!.loteId, quantidade: 0, qtdTexto: '', depositos: 1 }])}
                    >
                      <Plus className="mr-1 h-4 w-4" /> Produto
                    </Button>
                  )}
                </div>
                {!produtos.length && <Alert tone="warn">O depósito de endemias não tem larvicida com saldo no pacote baixado. Informe o número do lote: a baixa fica para a supervisão.</Alert>}
                {tratamentos.map((tr, i) => {
                  const p = produtos.find((x) => x.id === tr.produtoId);
                  const lote = p?.lotes.find((l) => l.loteId === tr.loteId);
                  const restante = lote ? lote.saldo - (usoNaFila.get(lote.loteId) ?? 0) - paraNumero(tr.qtdTexto) : null;
                  const atualizar = (patch: Partial<TratamentoCampo & { qtdTexto: string }>) => setTratamentos(tratamentos.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                  return (
                    <div key={tr.chave} className="rounded-lg border border-slate-200 p-2">
                      <div className="grid gap-2 sm:grid-cols-4">
                        <Field label="Produto" htmlFor={`vv-prod-${i}`} className="sm:col-span-2">
                          <Select id={`vv-prod-${i}`} value={tr.produtoId} onChange={(e) => atualizar({ produtoId: e.target.value, loteId: produtos.find((x) => x.id === e.target.value)?.lotes[0]?.loteId ?? null })}>
                            {produtos.map((x) => (
                              <option key={x.id} value={x.id}>
                                {x.nome}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field label="Lote" htmlFor={`vv-lote-${i}`}>
                          <Select id={`vv-lote-${i}`} value={tr.loteId ?? ''} onChange={(e) => atualizar({ loteId: e.target.value || null })}>
                            {p?.lotes.map((l) => (
                              <option key={l.loteId} value={l.loteId}>
                                {l.lote} · val. {l.validade.split('-').reverse().join('/')}
                                {l.vencido ? ' (vencido)' : ''}
                              </option>
                            ))}
                            <option value="">Outro lote (digitar)</option>
                          </Select>
                        </Field>
                        {!tr.loteId && (
                          <Field label="Número do lote" htmlFor={`vv-lote-num-${i}`}>
                            <Input id={`vv-lote-num-${i}`} value={tr.loteNumero ?? ''} onChange={(e) => atualizar({ loteNumero: e.target.value.toUpperCase() })} />
                          </Field>
                        )}
                        <Field label={`Quantidade (${p?.unidade ?? 'un'})`} htmlFor={`vv-qtd-${i}`}>
                          <Input id={`vv-qtd-${i}`} inputMode="decimal" value={tr.qtdTexto} onChange={(e) => atualizar({ qtdTexto: e.target.value.replace(/[^\d.,]/g, '').slice(0, 12) })} />
                        </Field>
                        <Field label="Depósitos" htmlFor={`vv-dep-${i}`}>
                          <Input id={`vv-dep-${i}`} inputMode="numeric" value={tr.depositos || ''} onChange={(e) => atualizar({ depositos: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
                        </Field>
                      </div>
                      <div className="mt-1 flex items-center justify-between text-xs text-slate-500">
                        <span>
                          {lote?.vencido && <span className="mr-2 text-red-700">Lote vencido: a baixa fica registrada como uso de lote vencido.</span>}
                          {restante !== null && restante < 0 ? (
                            <span className="text-amber-700">Saldo do lote no pacote não cobre: a baixa pode ficar pendente para a supervisão.</span>
                          ) : restante !== null ? (
                            `Saldo estimado depois: ${(Math.round(restante * 1000) / 1000).toLocaleString('pt-BR')} ${p?.unidade}`
                          ) : null}
                        </span>
                        <button type="button" className="text-red-700 hover:underline" onClick={() => setTratamentos(tratamentos.filter((_, j) => j !== i))}>
                          Remover
                        </button>
                      </div>
                    </div>
                  );
                })}
                <p className="text-xs text-slate-500">Dose pela capacidade do depósito, conforme a nota técnica vigente do larvicida. Água de beber (A1/A2) só como última alternativa.</p>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              {atividade === 'BLOQUEIO' && (
                <Field label="Nebulização costal (UBV)" htmlFor="vv-ubv">
                  <Select id="vv-ubv" value={ubv} onChange={(e) => setUbv(e.target.value as LocalUbv | '')}>
                    <option value="">Não aplicada</option>
                    {LOCAIS_UBV.map((l) => (
                      <option key={l} value={l}>
                        {LOCAL_UBV_LABEL[l]}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <label className="flex items-center gap-2 self-end text-sm">
                <input type="checkbox" checked={educativa} onChange={(e) => setEducativa(e.target.checked)} /> Orientação ao morador (ação educativa)
              </label>
            </div>
          </>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={localizar} loading={localizando}>
            <LocateFixed className="mr-1 h-4 w-4" /> Marcar minha posição
          </Button>
          <span className="text-sm text-slate-600">
            {posicao
              ? `${posicao.latitude}, ${posicao.longitude}${posicao.precisao ? ` (±${posicao.precisao} m)` : ''}${posicao.precisao != null && avaliarGps(posicao.precisao) === 'NOVA_LEITURA' ? ' · acima de 50 m: fica na visita, mas não posiciona o imóvel' : ''}`
              : imovel?.posicaoAproximada
                ? 'Imóvel com posição aproximada: marque a posição para confirmar em campo'
                : 'Opcional: confirma a posição do imóvel'}
          </span>
          {erroGps && <span className="text-sm text-red-700">{erroGps}</span>}
        </div>
        <Field label="Observações" htmlFor="vv-obs">
          <Textarea id="vv-obs" rows={2} value={obs} onChange={(e) => setObs(e.target.value)} placeholder={pendente ? 'Ex.: morador pediu retorno à tarde; cachorro solto' : ''} />
        </Field>
        {erros.length > 0 && (
          <Alert tone="error" title="Confira antes de salvar">
            <ul className="list-disc pl-5">
              {erros.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </Alert>
        )}
      </div>
    </Dialog>
  );
}
