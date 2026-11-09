'use client';

import {
  ATIVIDADE_INFO,
  ATIVIDADES_VETORIAIS,
  avaliarGps,
  conferirVisitaVetorial,
  DEPOSITO_INFO,
  lerNumeroPtBr,
  LIMITES_CAMPO_ACE,
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
  type SituacaoVisita,
  type TipoDeposito,
  type VisitaVetorialCampo,
} from '@omnisaude/shared';
import { LocateFixed, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import {
  ajustarLinhaAutomatica,
  loteSugerido,
  numeroDoBotao,
  ordemDoFormulario,
  paraDataHoraLocal,
  produtoSugerido,
  produtosDoFormulario,
  quantidadeParaTexto,
  seguinteTubito,
  type LinhaTratamento,
  type VisitaOp,
} from '@/lib/ace-campo';
import { contadorTubito } from '@/lib/ace-store';
import { cn } from '@/lib/cn';
import { ErroAparelho, obterPosicao, uuid, type Posicao } from '@/lib/offline';
import type { ImovelCampoView, LoteCampo, ProdutoCampo } from './types';

const L = LIMITES_CAMPO_ACE;
const vazio: ContagemDeposito = { inspecionados: 0, comFoco: 0, eliminados: 0, tratados: 0 };
const COLUNAS: { chave: keyof ContagemDeposito; rotulo: string }[] = [
  { chave: 'inspecionados', rotulo: 'Inspec.' },
  { chave: 'comFoco', rotulo: 'Com foco' },
  { chave: 'eliminados', rotulo: 'Elimin.' },
  { chave: 'tratados', rotulo: 'Tratados' },
];
/** Só os dígitos, até 999 (contagens, tubitos, larvas). */
const contagem = (texto: string) => Math.min(L.contagem, Number(texto.replace(/\D/g, '').slice(0, 3)) || 0);

export interface ContextoVisita {
  imovel: ImovelCampoView;
  /**
   * Ordem de bloqueio que inclui o quarteirão do imóvel: a visita de bloqueio entra nela, se a data não for de dia
   * anterior ao da abertura (`abertaEm`, do pacote; sem ela, o servidor confere).
   */
  ordem: { id: string; numero: string; abertaEm?: string | null } | null;
  quarteirao: string | null;
}

/** Mensagem para o agente quando o registro não pôde ser guardado no aparelho (o diálogo continua aberto). */
export function falhaAoGuardar(e: unknown): string {
  if (e instanceof ErroAparelho) return e.message;
  return `Não foi possível guardar no aparelho: ${e instanceof Error ? e.message : String(e)}`;
}

/**
 * Boletim de campo de uma visita do ACE: situação do imóvel, depósitos por tipo (A1 a E), tubitos coletados, larvicida
 * usado (produto, lote e quantidade, baixados do depósito de endemias), nebulização no bloqueio e GPS. Conferido no
 * aparelho com as mesmas regras e limites da API antes de entrar na fila. Com `inicial`, corrige um registro da fila
 * (mesmo clientId).
 */
export function VisitaVetorialForm({
  aberto,
  onClose,
  contexto,
  produtos: catalogo,
  estoque,
  userId,
  usoNaFila,
  inicial,
  onSalvar,
}: {
  aberto: boolean;
  onClose: () => void;
  contexto: ContextoVisita | null;
  /** Catálogo de insumos do pacote (com ou sem saldo). */
  produtos: ProdutoCampo[] | undefined;
  /** Lotes com saldo no depósito da unidade (sugestão de lote). */
  estoque: LoteCampo[];
  userId: string;
  /** Quantidade já usada por lote nas visitas que ainda estão na fila (só para avisar, nunca bloqueia). */
  usoNaFila: Map<string, number>;
  /** Registro da fila que está sendo corrigido. */
  inicial?: VisitaOp | null;
  /** Guarda no aparelho; rejeita se não conseguiu (o diálogo continua aberto com a mensagem). */
  onSalvar: (op: VisitaOp, rotulo: string, extras: { ultimoTubito: number | null }) => Promise<void>;
}) {
  const imovel = contexto?.imovel ?? null;
  const [atividade, setAtividade] = useState<AtividadeVetorial>('LI_T');
  const [situacao, setSituacao] = useState<SituacaoVisita>('TRABALHADO');
  const [depositos, setDepositos] = useState<Partial<Record<TipoDeposito, ContagemDeposito>>>({});
  const [amostras, setAmostras] = useState<AmostraCampo[]>([]);
  const [tratamentos, setTratamentos] = useState<LinhaTratamento[]>([]);
  const [ubv, setUbv] = useState<LocalUbv | ''>('');
  const [educativa, setEducativa] = useState(true);
  const [obs, setObs] = useState('');
  const [quando, setQuando] = useState(() => paraDataHoraLocal());
  const [posicao, setPosicao] = useState<Posicao | null>(null);
  const [localizando, setLocalizando] = useState(false);
  const [erroGps, setErroGps] = useState<string | null>(null);
  const [erros, setErros] = useState<string[]>([]);
  const [salvando, setSalvando] = useState(false);
  /** Próximo número da sequência de tubitos do agente. */
  const [proximoTubito, setProximoTubito] = useState(1);
  /** Último número dado pelo botão nesta visita: vira a posição da sequência quando a visita é guardada. */
  const [ultimoDoBotao, setUltimoDoBotao] = useState<number | null>(null);
  // Cada abertura e cada fechamento mudam a geração: a leitura do GPS (ou do contador) pedida antes é descartada, para a
  // posição de uma casa não aparecer na visita da casa seguinte.
  const geracao = useRef(0);

  useEffect(() => {
    geracao.current += 1;
    const g = geracao.current;
    setLocalizando(false);
    setErroGps(null);
    if (!aberto) return;
    const v: Partial<VisitaVetorialCampo> = inicial?.visita ?? {};
    setAtividade(v.atividade ?? (contexto?.ordem ? 'BLOQUEIO' : 'LI_T'));
    setSituacao(v.situacao ?? 'TRABALHADO');
    setDepositos(v.depositos ?? {});
    setAmostras(v.amostras ?? []);
    setTratamentos((v.tratamentos ?? []).map((t) => ({ ...t, chave: uuid(), qtdTexto: quantidadeParaTexto(t.quantidade), automatica: false })));
    setUbv(v.ubv ?? '');
    setEducativa(v.acaoEducativa ?? true);
    setObs(v.observacoes ?? '');
    setQuando(paraDataHoraLocal(inicial?.registradoEm));
    setPosicao(v.latitude != null && v.longitude != null ? { latitude: v.latitude, longitude: v.longitude, precisao: v.precisaoGps ?? null } : null);
    setErros([]);
    setUltimoDoBotao(null);
    void contadorTubito
      .ler(userId)
      .catch(() => 0)
      .then((n) => {
        if (g === geracao.current) setProximoTubito(seguinteTubito(n));
      });
  }, [aberto, contexto, userId, inicial]);

  const pendente = SITUACAO_INFO[situacao].pendencia;
  // Só a visita de bloqueio entra na ordem, e só a de data a partir do dia da abertura.
  const daOrdem = ordemDoFormulario(contexto?.ordem, atividade, quando);
  const totais = totaisDepositos(depositos);
  const ehPe = imovel?.tipo === '04';
  const produtos = useMemo(() => produtosDoFormulario(catalogo, estoque), [catalogo, estoque]);

  const mudar = (tipo: TipoDeposito, chave: keyof ContagemDeposito, valor: string) => {
    const n = contagem(valor);
    setDepositos((d) => ({ ...d, [tipo]: { ...(d[tipo] ?? vazio), [chave]: n } }));
  };

  const novaLinha = (depositosTratados: number, emUso: ReadonlySet<string> = new Set()): LinhaTratamento | null => {
    const p = produtoSugerido(produtos, emUso);
    return p ? { chave: uuid(), produtoId: p.id, loteId: loteSugerido(p.lotes), loteNumero: null, quantidade: 0, qtdTexto: '', depositos: depositosTratados } : null;
  };

  // Depósitos tratados na tabela puxam uma linha de larvicida que acompanha o total até o agente mexer nela.
  useEffect(() => {
    if (pendente) return;
    setTratamentos((atual) =>
      ajustarLinhaAutomatica(atual, totais.tratados, (n) => {
        const linha = novaLinha(n);
        return linha ? { ...linha, automatica: true } : null;
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendente, totais.tratados, produtos]);

  const localizar = async () => {
    const g = geracao.current;
    setLocalizando(true);
    setErroGps(null);
    try {
      const p = await obterPosicao();
      if (g === geracao.current) setPosicao(p);
    } catch (e) {
      if (g === geracao.current) setErroGps(e instanceof Error ? e.message : String(e));
    } finally {
      if (g === geracao.current) setLocalizando(false);
    }
  };

  const salvar = async () => {
    if (!imovel) return;
    const lidas = tratamentos.map((t) => ({ t, quantidade: lerNumeroPtBr(t.qtdTexto) }));
    const visita: VisitaVetorialCampo = {
      atividade,
      situacao,
      ordemId: daOrdem.ordemId,
      ...(pendente
        ? {}
        : {
            depositos: Object.fromEntries(Object.entries(depositos).filter(([, c]) => c && (c.inspecionados || c.comFoco || c.eliminados || c.tratados))) as Depositos,
            amostras,
            tratamentos: lidas.map(({ t: { chave: _c, qtdTexto: _q, automatica: _a, ...t }, quantidade }) => ({ ...t, loteNumero: t.loteId ? null : t.loteNumero?.trim() || null, quantidade: quantidade ?? 0 })),
            ubv: atividade === 'BLOQUEIO' && ubv ? ubv : null,
            acaoEducativa: educativa,
          }),
      latitude: posicao?.latitude ?? null,
      longitude: posicao?.longitude ?? null,
      precisaoGps: posicao?.precisao ?? null,
      observacoes: obs.trim() || null,
    };
    // Quantidade no formato brasileiro: "2.5" é ambíguo e é recusado, para nunca baixar mil vezes mais ou menos.
    const ilegiveis = pendente ? [] : lidas.filter(({ t, quantidade }) => t.qtdTexto.trim() && quantidade == null).map(({ t }) => t.qtdTexto.trim());
    let problemas = conferirVisitaVetorial(visita, { pontoEstrategico: ehPe });
    if (ilegiveis.length) {
      if (!lidas.some(({ t }) => !t.qtdTexto.trim())) problemas = problemas.filter((p) => p !== 'Quantidade de larvicida maior que zero');
      problemas.unshift(...ilegiveis.map((q) => `Quantidade "${q}" ilegível: use vírgula para decimais (2,5) e ponto só para milhar (1.000)`));
    }
    if (!quando || Number.isNaN(new Date(quando).getTime())) problemas.push('Informe a data e a hora da visita');
    else if (new Date(quando).getTime() > Date.now() + 5 * 60_000) problemas.push('A data da visita não pode estar no futuro');
    setErros(problemas);
    if (problemas.length) return;
    const base = { tipo: 'VISITA_VETORIAL' as const, clientId: inicial?.clientId ?? uuid(), registradoEm: new Date(quando).toISOString(), visita };
    const op: VisitaOp = imovel.pendente ? { ...base, householdClientId: imovel.id } : { ...base, householdId: imovel.id };
    setSalvando(true);
    try {
      await onSalvar(op, `${SITUACAO_INFO[situacao].label} · ${contexto?.quarteirao ? `Q ${contexto.quarteirao} · ` : ''}${imovel.endereco}`, { ultimoTubito: ultimoDoBotao });
    } catch (e) {
      setErros([falhaAoGuardar(e)]);
      return;
    } finally {
      setSalvando(false);
    }
    onClose();
  };

  const linhasCheias = tratamentos.length >= L.produtos;

  return (
    <Dialog
      open={aberto}
      onOpenChange={(o) => !o && onClose()}
      title={inicial ? 'Corrigir a visita' : 'Visita ao imóvel'}
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
        {daOrdem.ordemId && <Alert tone="info">Faz parte da ordem de bloqueio {contexto?.ordem?.numero}.</Alert>}
        {daOrdem.aviso && <Alert tone="warn">{daOrdem.aviso}</Alert>}
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
                  {TIPOS_DEPOSITO.map((t) => {
                    const regra = DEPOSITO_INFO[t].tratamento;
                    const naoTrata = regra === 'NAO_TRATAR' || (regra === 'SO_PONTO_ESTRATEGICO' && !ehPe);
                    return (
                      <tr key={t} className="border-t border-slate-100">
                        <td
                          className="py-1 pr-2"
                          title={regra === 'SO_PONTO_ESTRATEGICO' ? `${DEPOSITO_INFO[t].descricao}. Lixo e entulho: elimine; só a sucata do ponto estratégico recebe larvicida` : DEPOSITO_INFO[t].descricao}
                        >
                          <span className="font-semibold">{t}</span> <span className="text-xs text-slate-500">{DEPOSITO_INFO[t].grupo}</span>
                          {naoTrata && <span className="ml-1 text-xs text-amber-700">não tratar</span>}
                          {/* Em ponto estratégico a coluna fica liberada, mas só para a sucata: lixo e entulho se eliminam. */}
                          {regra === 'SO_PONTO_ESTRATEGICO' && ehPe && <span className="ml-1 text-xs text-amber-700">só sucata</span>}
                        </td>
                        {COLUNAS.map((c) => (
                          <td key={c.chave} className="px-1 py-1">
                            <Input
                              aria-label={`${t} ${c.rotulo}`}
                              inputMode="numeric"
                              maxLength={3}
                              className="h-9 w-16 text-center"
                              value={depositos[t]?.[c.chave] ? String(depositos[t]![c.chave]) : ''}
                              onChange={(e) => mudar(t, c.chave, e.target.value)}
                              disabled={c.chave === 'tratados' && naoTrata}
                            />
                          </td>
                        ))}
                      </tr>
                    );
                  })}
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
                    disabled={amostras.length >= L.amostras}
                    onClick={() => {
                      const n = numeroDoBotao(proximoTubito, new Set(amostras.map((a) => a.numero)));
                      const tipo = TIPOS_DEPOSITO.find((t) => (depositos[t]?.comFoco ?? 0) > amostras.filter((a) => a.deposito === t).length) ?? 'C';
                      setAmostras([...amostras, { numero: n, deposito: tipo }]);
                      setProximoTubito(seguinteTubito(n));
                      setUltimoDoBotao(n);
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
                        maxLength={3}
                        className="w-20"
                        value={a.numero || ''}
                        onChange={(e) => setAmostras(amostras.map((x, j) => (j === i ? { ...x, numero: contagem(e.target.value) } : x)))}
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
                        maxLength={3}
                        className="w-20"
                        value={a.larvas ?? ''}
                        onChange={(e) => setAmostras(amostras.map((x, j) => (j === i ? { ...x, larvas: e.target.value.replace(/\D/g, '') ? contagem(e.target.value) : null } : x)))}
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
                      disabled={linhasCheias}
                      onClick={() => {
                        const linha = novaLinha(1, new Set(tratamentos.map((t) => t.produtoId)));
                        if (linha) setTratamentos([...tratamentos.map((t) => ({ ...t, automatica: false })), linha]);
                      }}
                    >
                      <Plus className="mr-1 h-4 w-4" /> Produto
                    </Button>
                  )}
                </div>
                {!produtos.length && <Alert tone="warn">Nenhum insumo de controle vetorial no pacote baixado: peça à supervisão o cadastro do larvicida e baixe o pacote de novo.</Alert>}
                {produtos.length > 0 && !estoque.length && (
                  <Alert tone="warn">O depósito de endemias não tem lote com saldo no pacote baixado: escolha o produto e digite o número do lote; a baixa fica pendente para a supervisão.</Alert>
                )}
                {tratamentos.map((tr, i) => {
                  const p = produtos.find((x) => x.id === tr.produtoId);
                  const lote = p?.lotes.find((l) => l.loteId === tr.loteId);
                  const usada = lerNumeroPtBr(tr.qtdTexto) ?? 0;
                  const restante = lote ? lote.saldo - (usoNaFila.get(lote.loteId) ?? 0) - usada : null;
                  const atualizar = (patch: Partial<LinhaTratamento>) => setTratamentos(tratamentos.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                  return (
                    <div key={tr.chave} className="rounded-lg border border-slate-200 p-2">
                      <div className="grid gap-2 sm:grid-cols-4">
                        <Field label="Produto" htmlFor={`vv-prod-${i}`} className="sm:col-span-2">
                          <Select
                            id={`vv-prod-${i}`}
                            value={tr.produtoId}
                            onChange={(e) => {
                              const novo = produtos.find((x) => x.id === e.target.value);
                              atualizar({ produtoId: e.target.value, loteId: novo ? loteSugerido(novo.lotes) : null, loteNumero: null });
                            }}
                          >
                            {!p && <option value={tr.produtoId}>Produto fora do pacote baixado</option>}
                            {produtos.map((x) => (
                              <option key={x.id} value={x.id}>
                                {x.nome}
                                {x.lotes.length ? '' : ' (sem saldo no pacote)'}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        {p?.lotes.length ? (
                          <Field label="Lote" htmlFor={`vv-lote-${i}`}>
                            <Select id={`vv-lote-${i}`} value={tr.loteId ?? ''} onChange={(e) => atualizar({ loteId: e.target.value || null })}>
                              {p.lotes.map((l) => (
                                <option key={l.loteId} value={l.loteId}>
                                  {l.lote} · val. {l.validade.split('-').reverse().join('/')}
                                  {l.vencido ? ' (vencido)' : ''}
                                </option>
                              ))}
                              <option value="">Outro lote (digitar)</option>
                            </Select>
                          </Field>
                        ) : null}
                        {!tr.loteId && (
                          <Field label="Número do lote" htmlFor={`vv-lote-num-${i}`}>
                            <Input id={`vv-lote-num-${i}`} value={tr.loteNumero ?? ''} maxLength={L.lote} onChange={(e) => atualizar({ loteNumero: e.target.value.toUpperCase() })} />
                          </Field>
                        )}
                        <Field label={`Quantidade (${p?.unidade ?? 'un'})`} htmlFor={`vv-qtd-${i}`}>
                          <Input id={`vv-qtd-${i}`} inputMode="decimal" value={tr.qtdTexto} onChange={(e) => atualizar({ qtdTexto: e.target.value.replace(/[^\d.,]/g, '').slice(0, 12) })} />
                        </Field>
                        <Field label="Depósitos" htmlFor={`vv-dep-${i}`}>
                          <Input id={`vv-dep-${i}`} inputMode="numeric" maxLength={3} value={tr.depositos || ''} onChange={(e) => atualizar({ depositos: contagem(e.target.value), automatica: false })} />
                        </Field>
                      </div>
                      <div className="mt-1 flex items-center justify-between text-xs text-slate-500">
                        <span>
                          {lote?.vencido && <span className="mr-2 text-red-700">Lote vencido: a baixa fica registrada como uso de lote vencido.</span>}
                          {!tr.loteId && <span className="mr-2">Lote fora do pacote: a baixa fica pendente para a supervisão.</span>}
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
        <Field label="Observações" htmlFor="vv-obs" hint={obs.length > L.observacaoVisita - 100 ? `${obs.length}/${L.observacaoVisita} caracteres` : undefined}>
          <Textarea id="vv-obs" rows={2} maxLength={L.observacaoVisita} value={obs} onChange={(e) => setObs(e.target.value)} placeholder={pendente ? 'Ex.: morador pediu retorno à tarde; cachorro solto' : ''} />
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
