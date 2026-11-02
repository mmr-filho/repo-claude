'use client';

import { PRECISAO_INFO, type PrecisaoGeo } from '@omnisaude/shared';
import { Lock, Radius, X } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { MapaTerritorio, type PontoCaso } from '@/components/territorio/mapa-territorio';
import type { CamadasMapa } from '@/components/territorio/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, Stat } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { fmtDate, todayIso } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { ListaBloqueio, type QuarteiroesDoCaso } from './bloqueio';

interface PontoMapa {
  id: string;
  numero: string | null;
  agravo: string;
  grupo: string | null;
  status: string;
  prazo: string;
  conhecimento: string;
  lat: number;
  lng: number;
  precisao: PrecisaoGeo;
  precisaoLabel: string;
  fonte: 'cadastro' | 'ficha';
  blockId: string | null;
}

interface MapaCasos {
  pontos: PontoMapa[];
  semPosicao: number;
  ocultasPorSigilo: number;
  porQuarteirao: { id: string; numero: string; localidade: { code: string; name: string } | null; bairro: string | null; centro: { lat: number; lng: number }; casos: number }[];
  raioBloqueioM: number;
  limitado: boolean;
}

/** Paleta de categorias (até 8 agravos; o resto fica cinza). */
const CORES = ['#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed', '#db2777', '#0891b2', '#65a30d'];

const STATUS: Record<string, string> = { RASCUNHO: 'Em preenchimento', NOTIFICADA: 'Notificada', ENCERRADA: 'Encerrada' };

/**
 * Mapa de casos notificados (só a vigilância epidemiológica e o núcleo de vigilância): pontos na residência, com
 * contorno tracejado quando a posição não serve ao bloqueio sem confirmar em campo. Clicar num caso traça o raio do
 * bloqueio e lista os quarteirões atingidos.
 */
export function MapaCasosTab() {
  const session = useSession();
  const [periodo, setPeriodo] = useState({ de: todayIso(-90), ate: todayIso() });
  const [agravo, setAgravo] = useState('');
  const dados = useApi<MapaCasos>(`/vigilancia/mapa?de=${periodo.de}&ate=${periodo.ate}`, [periodo.de, periodo.ate]);
  const [bbox, setBbox] = useState<string | null>(null);
  const camadas = useApi<CamadasMapa>(bbox && session.can('territorio.ler') ? `/territorio/mapa?bbox=${bbox}` : null, [bbox]);
  const [sel, setSel] = useState<string | null>(null);
  const [metros, setMetros] = useState('');
  // A API aceita de 10 a 2.000 m; enquanto digita, vale o limite mais próximo.
  const raioM = Math.min(2000, Math.max(10, Number(metros) || dados.data?.raioBloqueioM || 150));
  const bloqueio = useApi<QuarteiroesDoCaso>(sel ? `/vigilancia/notificacoes/${sel}/quarteiroes?metros=${raioM}` : null, [sel, raioM]);

  const agravos = useMemo(() => {
    const cont = new Map<string, number>();
    for (const p of dados.data?.pontos ?? []) cont.set(p.agravo, (cont.get(p.agravo) ?? 0) + 1);
    return [...cont.entries()].sort((a, b) => b[1] - a[1]);
  }, [dados.data]);
  const cor = useMemo(() => new Map(agravos.slice(0, CORES.length).map(([a], i) => [a, CORES[i]!])), [agravos]);
  const visiveis = (dados.data?.pontos ?? []).filter((p) => !agravo || p.agravo === agravo);
  const casos: PontoCaso[] = visiveis.map((p) => ({
    id: p.id,
    lat: p.lat,
    lng: p.lng,
    cor: cor.get(p.agravo) ?? '#64748b',
    incerto: PRECISAO_INFO[p.precisao].bloqueio === 'CONFIRMAR_EM_CAMPO',
    titulo: `${p.agravo} · ${STATUS[p.status] ?? p.status} · ${fmtDate(p.conhecimento)} · ${p.precisaoLabel}`,
  }));
  const caso = visiveis.find((p) => p.id === sel) ?? null;

  return (
    <div className="flex flex-col gap-4" id="vig-mapa-casos">
      <Alert tone="info" title="Uso restrito à vigilância">
        Notificação compulsória é sigilosa (Lei 6.259/1975, art. 10). O mapa mostra a residência sem nome; agravo sigiloso só aparece para quem pode abrir a ficha, e cada consulta fica na auditoria.
      </Alert>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Conhecimento de" htmlFor="vig-mapa-de">
          <Input id="vig-mapa-de" type="date" value={periodo.de} onChange={(e) => e.target.value && setPeriodo({ ...periodo, de: e.target.value })} />
        </Field>
        <Field label="até" htmlFor="vig-mapa-ate">
          <Input id="vig-mapa-ate" type="date" value={periodo.ate} onChange={(e) => e.target.value && setPeriodo({ ...periodo, ate: e.target.value })} />
        </Field>
        <Field label="Agravo" htmlFor="vig-mapa-agravo">
          <Select id="vig-mapa-agravo" value={agravo} onChange={(e) => setAgravo(e.target.value)}>
            <option value="">Todos</option>
            {agravos.map(([a, n]) => (
              <option key={a} value={a}>
                {a} ({n})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Raio do bloqueio (m)" htmlFor="vig-mapa-raio">
          <Input id="vig-mapa-raio" className="w-24" inputMode="numeric" placeholder={String(dados.data?.raioBloqueioM ?? 150)} value={metros} onChange={(e) => setMetros(e.target.value.replace(/\D/g, '').slice(0, 4))} />
        </Field>
      </div>
      {dados.loading && !dados.data ? (
        <Spinner />
      ) : dados.error ? (
        <Alert tone="error">{dados.error}</Alert>
      ) : (
        dados.data && (
          <>
            <div className="grid gap-3 sm:grid-cols-4">
              <Stat label="Casos no mapa" value={visiveis.length} />
              <Stat label="Sem posição da residência" value={dados.data.semPosicao} tone={dados.data.semPosicao ? 'warn' : 'good'} hint="Marque o imóvel no território" />
              <Stat label="Posição a confirmar em campo" value={casos.filter((c) => c.incerto).length} tone={casos.some((c) => c.incerto) ? 'warn' : 'good'} />
              <Stat label="Ocultos por sigilo" value={dados.data.ocultasPorSigilo} hint={dados.data.ocultasPorSigilo ? 'Agravos que seu papel não abre' : undefined} />
            </div>
            {dados.data.limitado && <Alert tone="warn">Mais de 5.000 notificações no período: só as mais recentes estão no mapa. Encurte o período.</Alert>}
            <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,1.2fr)]">
              <div className="flex flex-col gap-2">
                <MapaTerritorio
                  camadas={camadas.data}
                  casos={casos}
                  destaque={sel ? bloqueio.data?.quarteiroes.map((q) => q.id) : undefined}
                  raio={sel && bloqueio.data?.ponto ? { ...bloqueio.data.ponto, metros: bloqueio.data.raioM } : null}
                  onMover={(b) => setBbox(b.map((n) => n.toFixed(5)).join(','))}
                  onCaso={setSel}
                  className="h-[600px]"
                />
                <div className="flex flex-wrap gap-3 text-xs text-slate-600" aria-label="Legenda">
                  {agravos.slice(0, CORES.length).map(([a]) => (
                    <span key={a} className="flex items-center gap-1">
                      <span className="inline-block h-3 w-3 rounded-full" style={{ background: cor.get(a) }} />
                      {a}
                    </span>
                  ))}
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-3 w-3 rounded-full border border-dashed border-slate-900" /> Posição a confirmar em campo
                  </span>
                </div>
              </div>
              <div className="flex flex-col gap-4">
                {caso ? (
                  <Card id="vig-mapa-caso">
                    <CardHeader
                      title={caso.agravo}
                      description={`${STATUS[caso.status] ?? caso.status} · conhecimento em ${fmtDate(caso.conhecimento)}${caso.numero ? ` · nº ${caso.numero}` : ''}`}
                      actions={
                        <Button size="sm" variant="ghost" aria-label="Fechar" onClick={() => setSel(null)}>
                          <X className="h-4 w-4" />
                        </Button>
                      }
                    />
                    <CardBody className="flex flex-col gap-3">
                      <p className="flex items-center gap-1 text-sm font-medium">
                        <Radius className="h-4 w-4" /> Quarteirões a até {raioM} m
                      </p>
                      {bloqueio.loading && !bloqueio.data ? <Spinner /> : bloqueio.data && <ListaBloqueio q={bloqueio.data} />}
                      <Link href={`/vigilancia/notificacao?id=${caso.id}`} className="text-sm font-medium text-brand-700 hover:underline">
                        Abrir a ficha
                      </Link>
                    </CardBody>
                  </Card>
                ) : (
                  <p className="text-sm text-slate-500">Clique num caso para traçar o raio do bloqueio.</p>
                )}
                <Card>
                  <CardHeader title="Quarteirões com mais casos" description="No período e filtro do mapa." />
                  <CardBody className="max-h-96 overflow-auto p-0">
                    {dados.data.porQuarteirao.length === 0 ? (
                      <p className="p-4 text-sm text-slate-500">Nenhum caso ligado a quarteirão.</p>
                    ) : (
                      <ul className="divide-y divide-slate-100 text-sm">
                        {dados.data.porQuarteirao.slice(0, 30).map((q) => (
                          <li key={q.id} className="flex items-center justify-between px-4 py-2">
                            <span>
                              Quarteirão <b>{q.numero}</b>
                              <span className="text-xs text-slate-500">
                                {' '}
                                · {q.localidade?.name}
                                {q.bairro ? ` · ${q.bairro}` : ''}
                              </span>
                            </span>
                            <Badge tone={q.casos >= 3 ? 'red' : q.casos === 2 ? 'amber' : 'slate'}>{q.casos}</Badge>
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardBody>
                </Card>
                {dados.data.ocultasPorSigilo > 0 && (
                  <p className="flex items-center gap-1 text-xs text-slate-500">
                    <Lock className="h-3.5 w-3.5" /> {dados.data.ocultasPorSigilo} caso(s) de agravo sigiloso fora do mapa.
                  </p>
                )}
              </div>
            </div>
          </>
        )
      )}
    </div>
  );
}
