'use client';

import { PRECISAO_INFO, type PrecisaoGeo } from '@omnisaude/shared';
import { Crosshair, MapPin, PenLine, Radius, Shapes, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { MapaTerritorio, type ModoMapa } from './mapa-territorio';
import { COR_PRECISAO, type Bairro, type CamadasMapa, type Geometria, type ImovelPendente, type Localidade, type QuarteiraoNoRaio } from './types';

type Ferramenta = 'navegar' | 'raio' | 'desenhar' | 'editar' | 'posicionar';

interface DetalheQuarteirao {
  id: string;
  number: string;
  notes: string | null;
  areaM2: number;
  updatedAt: string;
  geometry: Geometria;
  locality: { id: string; code: string; name: string };
  neighborhood: { id: string; name: string } | null;
  imoveis: ImovelPendente[];
}

export function AbaMapa({
  podeEditar,
  podePosicionar = podeEditar,
  raioPadrao,
  imovelAPosicionar,
  onPosicionado,
  onAlterado,
  onCancelarPosicao,
}: {
  podeEditar: boolean;
  /** Marcar a posição do imóvel: quem edita o território e o ACS em campo. */
  podePosicionar?: boolean;
  raioPadrao: number;
  imovelAPosicionar?: ImovelPendente | null;
  onPosicionado?: () => void;
  /** Quarteirão criado, editado ou desativado (o resumo da página recarrega). */
  onAlterado?: () => void;
  /** A marcação do imóvel vinda das pendências foi abandonada. */
  onCancelarPosicao?: () => void;
}) {
  const toast = useToast();
  const [bbox, setBbox] = useState<string | null>(null);
  const camadas = useApi<CamadasMapa>(bbox ? `/territorio/mapa?bbox=${bbox}` : null, [bbox]);
  const localidades = useApi<Localidade[]>('/territorio/localidades');
  const [ferramenta, setFerramenta] = useState<Ferramenta>('navegar');
  const [selQ, setSelQ] = useState<string | null>(null);
  const [selImovel, setSelImovel] = useState<string | null>(null);
  const detalhe = useApi<DetalheQuarteirao>(selQ ? `/territorio/quarteiroes/${selQ}` : null, [selQ]);
  const [raio, setRaio] = useState<{ lat: number; lng: number; metros: number; quarteiroes: QuarteiraoNoRaio[] } | null>(null);
  const [metros, setMetros] = useState(String(raioPadrao));
  const [rascunho, setRascunho] = useState<Geometria | null>(null);
  const [form, setForm] = useState({ localityId: '', neighborhoodId: '', number: '', notes: '' });
  const bairros = useApi<Bairro[]>(form.localityId ? `/territorio/bairros?localidade=${form.localityId}` : null, [form.localityId]);
  const [desativar, setDesativar] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (imovelAPosicionar) {
      setSelImovel(imovelAPosicionar.id);
      setFerramenta('posicionar');
    }
  }, [imovelAPosicionar]);

  const imovel = camadas.data?.imoveis.find((h) => h.id === selImovel) ?? null;
  // Lista estável entre renderizações: o mapa só redesenha os quarteirões quando o raio muda.
  const destaque = useMemo(() => raio?.quarteiroes.map((q) => q.id), [raio]);
  // Desenho concluído fica no mapa, editável, até salvar ou cancelar.
  const modo: ModoMapa = ferramenta === 'raio' || ferramenta === 'posicionar' ? 'clicar' : ferramenta === 'desenhar' ? (rascunho ? 'editar' : 'desenhar') : ferramenta === 'editar' ? 'editar' : 'navegar';
  const geometriaEdicao = ferramenta === 'editar' ? (rascunho ?? detalhe.data?.geometry ?? null) : ferramenta === 'desenhar' ? rascunho : null;

  /** Trocar de quarteirão no meio da edição descarta o rascunho (ele é do quarteirão anterior). */
  function selecionarQuarteirao(id: string | null) {
    setSelQ(id);
    setSelImovel(null);
    if (ferramenta === 'editar') {
      setRascunho(null);
      setFerramenta('navegar');
    }
  }

  /** Sair da marcação do imóvel desarma o pedido vindo das pendências. */
  function trocarFerramenta(f: Ferramenta) {
    if (ferramenta === 'posicionar' && f !== 'posicionar') onCancelarPosicao?.();
    setFerramenta(f);
  }

  async function clicar(lat: number, lng: number) {
    if (ferramenta === 'raio') {
      try {
        const m = Math.min(2000, Math.max(10, Number(metros) || raioPadrao));
        const r = await api.get<{ quarteiroes: QuarteiraoNoRaio[] }>(`/territorio/raio?lat=${lat}&lng=${lng}&metros=${m}`);
        setRaio({ lat, lng, metros: m, quarteiroes: r.quarteiroes });
      } catch (err) {
        toast.error(errorMessage(err));
      }
    }
    if (ferramenta === 'posicionar' && selImovel) {
      try {
        const r = await api.post<{ blockId: string | null }>(`/territorio/imoveis/${selImovel}/posicao`, { lat, lng, origem: 'MAPA' });
        toast.success(r.blockId ? 'Posição gravada e imóvel ligado ao quarteirão.' : 'Posição gravada (fora de quarteirão cadastrado).');
        setFerramenta('navegar');
        await camadas.reload();
        onPosicionado?.();
      } catch (err) {
        toast.error(errorMessage(err));
      }
    }
  }

  async function salvar() {
    if (!rascunho) return;
    setBusy(true);
    try {
      if (ferramenta === 'editar' && detalhe.data) {
        const r = await api.patch<{ religados: number }>(`/territorio/quarteiroes/${detalhe.data.id}`, { geometry: rascunho, versao: detalhe.data.updatedAt });
        toast.success(`Contorno salvo${r.religados ? `; ${r.religados} imóvel(is) religado(s)` : ''}.`);
      } else {
        const r = await api.post<{ id: string; religados: number }>('/territorio/quarteiroes', {
          localityId: form.localityId,
          neighborhoodId: form.neighborhoodId || null,
          number: form.number,
          notes: form.notes || null,
          geometry: rascunho,
        });
        toast.success(`Quarteirão ${form.number} criado${r.religados ? ` com ${r.religados} imóvel(is)` : ''}.`);
        setSelQ(r.id);
        setForm({ ...form, number: '', notes: '' });
      }
      setRascunho(null);
      setFerramenta('navegar');
      await Promise.all([camadas.reload(), detalhe.reload()]);
      onAlterado?.();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const ferramentas: { id: Ferramenta; label: string; icon: typeof Radius; so?: boolean }[] = [
    { id: 'navegar', label: 'Navegar', icon: MapPin },
    { id: 'raio', label: 'Raio de bloqueio', icon: Radius },
    { id: 'desenhar', label: 'Desenhar quarteirão', icon: Shapes, so: true },
  ];

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,1.2fr)]">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2" id="terr-ferramentas">
          {ferramentas
            .filter((f) => !f.so || podeEditar)
            .map((f) => (
              <Button
                key={f.id}
                size="sm"
                variant={ferramenta === f.id ? 'primary' : 'secondary'}
                id={`terr-ferramenta-${f.id}`}
                onClick={() => {
                  trocarFerramenta(f.id);
                  setRascunho(null);
                  if (f.id !== 'raio') setRaio(null);
                }}
              >
                <f.icon className="h-4 w-4" /> {f.label}
              </Button>
            ))}
          {ferramenta === 'raio' && (
            <span className="flex items-center gap-1 text-sm">
              <Input aria-label="Raio em metros" id="terr-raio-metros" className="w-20" value={metros} onChange={(e) => setMetros(e.target.value.replace(/\D/g, ''))} /> m · clique no mapa
            </span>
          )}
          {ferramenta === 'desenhar' && !rascunho && <span className="text-sm text-slate-600">Clique nos vértices e dê dois cliques para fechar o contorno.</span>}
          {ferramenta === 'posicionar' && <span className="text-sm text-slate-600">Clique no ponto exato do imóvel.</span>}
          {camadas.data?.limitado && <Badge tone="amber">Aproxime o mapa: há mais itens do que o mostrado</Badge>}
        </div>
        <MapaTerritorio
          camadas={camadas.data}
          modo={modo}
          quarteiraoSelecionado={selQ}
          ocultar={ferramenta === 'editar' ? selQ : null}
          imovelSelecionado={selImovel}
          destaque={destaque}
          raio={raio}
          geometriaEdicao={geometriaEdicao}
          onMover={(b) => setBbox(b.map((n) => n.toFixed(5)).join(','))}
          onClicar={clicar}
          onQuarteirao={(id) => selecionarQuarteirao(id)}
          onImovel={(id) => setSelImovel(id)}
          onGeometria={(g) => setRascunho(g)}
          centroInicial={imovelAPosicionar?.latitude != null && imovelAPosicionar.longitude != null ? [imovelAPosicionar.latitude, imovelAPosicionar.longitude] : null}
          className="h-[620px]"
        />
        <div className="flex flex-wrap gap-3 text-xs text-slate-600" aria-label="Legenda">
          {(['GPS_CAMPO', 'ENDERECO', 'FACE', 'LOGRADOURO'] as PrecisaoGeo[]).map((p) => (
            <span key={p} className="flex items-center gap-1">
              <span className="inline-block h-3 w-3 rounded-full" style={{ background: COR_PRECISAO[p] }} />
              {p === 'GPS_CAMPO' ? 'GPS ou mapa' : p === 'LOGRADOURO' ? 'Logradouro, bairro ou CEP (confirmar em campo)' : PRECISAO_INFO[p].label}
            </span>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {rascunho && (ferramenta === 'desenhar' || ferramenta === 'editar') && (
          <Card id="terr-rascunho">
            <CardHeader
              title={ferramenta === 'editar' ? 'Salvar o novo contorno' : 'Novo quarteirão'}
              actions={
                <Button size="sm" variant="ghost" onClick={() => (setRascunho(null), setFerramenta('navegar'))} aria-label="Cancelar">
                  <X className="h-4 w-4" />
                </Button>
              }
            />
            <CardBody className="flex flex-col gap-3">
              {ferramenta === 'desenhar' && (
                <>
                  <Field label="Localidade" htmlFor="terr-q-localidade">
                    <Select id="terr-q-localidade" value={form.localityId} onChange={(e) => setForm({ ...form, localityId: e.target.value, neighborhoodId: '' })}>
                      <option value="">Escolha…</option>
                      {localidades.data
                        ?.filter((l) => l.status === 'ATIVA')
                        .map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.code} · {l.name}
                          </option>
                        ))}
                    </Select>
                  </Field>
                  <Field label="Bairro (opcional)" htmlFor="terr-q-bairro">
                    <Select id="terr-q-bairro" value={form.neighborhoodId} onChange={(e) => setForm({ ...form, neighborhoodId: e.target.value })}>
                      <option value="">—</option>
                      {bairros.data?.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Número do quarteirão" htmlFor="terr-q-numero" hint="Ex.: 12, ou 12-A na numeração suplementar">
                    <Input id="terr-q-numero" value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value.toUpperCase() })} />
                  </Field>
                  <Field label="Observações" htmlFor="terr-q-notas">
                    <Textarea id="terr-q-notas" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                  </Field>
                </>
              )}
              <Button id="terr-q-salvar" loading={busy} disabled={ferramenta === 'desenhar' && (!form.localityId || !form.number.trim())} onClick={salvar}>
                Salvar
              </Button>
            </CardBody>
          </Card>
        )}

        {raio && (
          <Card id="terr-raio">
            <CardHeader
              title={`Quarteirões a até ${raio.metros} m`}
              description="Medido do ponto até a borda de cada quarteirão (o do ponto tem distância zero)."
              actions={
                <Button size="sm" variant="ghost" onClick={() => setRaio(null)} aria-label="Limpar raio">
                  <X className="h-4 w-4" />
                </Button>
              }
            />
            <CardBody className="max-h-72 overflow-auto p-0">
              {raio.quarteiroes.length === 0 ? (
                <p className="p-4 text-sm text-slate-500">Nenhum quarteirão cadastrado no raio.</p>
              ) : (
                <ul className="divide-y divide-slate-100 text-sm">
                  {raio.quarteiroes.map((q) => (
                    <li key={q.id} className="flex items-center justify-between gap-3 px-4 py-2">
                      <button type="button" className="whitespace-nowrap font-medium text-brand-700 hover:underline" onClick={() => selecionarQuarteirao(q.id)}>
                        Quarteirão {q.numero}
                      </button>
                      <span className="text-right text-xs text-slate-500">
                        {q.localidade?.name}
                        {q.bairro ? ` · ${q.bairro}` : ''} · {q.imoveis} imóv. · {q.distanciaM} m
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        )}

        {selQ && detalhe.data && (
          <Card id="terr-quarteirao">
            <CardHeader
              title={`Quarteirão ${detalhe.data.number}`}
              description={`${detalhe.data.locality.code} · ${detalhe.data.locality.name}${detalhe.data.neighborhood ? ` · ${detalhe.data.neighborhood.name}` : ''} · ${Math.round(detalhe.data.areaM2).toLocaleString('pt-BR')} m²`}
              actions={
                podeEditar ? (
                  <div className="flex gap-1">
                    <Button size="sm" variant="secondary" id="terr-editar-contorno" onClick={() => (setRascunho(null), trocarFerramenta('editar'))}>
                      <PenLine className="h-4 w-4" /> Contorno
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDesativar(detalhe.data!.id)}>
                      Desativar
                    </Button>
                  </div>
                ) : undefined
              }
            />
            <CardBody className="max-h-80 overflow-auto p-0 text-sm">
              {detalhe.data.notes && <p className="px-4 pt-3 text-slate-600">{detalhe.data.notes}</p>}
              {detalhe.data.imoveis.length === 0 ? (
                <p className="p-4 text-slate-500">Nenhum imóvel ligado a este quarteirão.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {detalhe.data.imoveis.map((h) => (
                    <li key={h.id} className="flex items-center justify-between gap-2 px-4 py-2">
                      <span>
                        {h.rgSequence ? <b className="mr-1">{h.rgSequence}</b> : null}
                        {h.endereco || 'Sem endereço'}
                      </span>
                      <span className="text-xs text-slate-500">{h.precisaoLabel}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        )}

        {selImovel && (
          <Card id="terr-imovel">
            <CardHeader title={imovel?.endereco || imovelAPosicionar?.endereco || 'Imóvel'} description={imovel?.precisao ? `Posição: ${PRECISAO_INFO[imovel.precisao].label}` : 'Sem posição no mapa'} />
            <CardBody className="flex flex-col gap-2 text-sm">
              {imovel?.precisao && PRECISAO_INFO[imovel.precisao].bloqueio !== 'AUTOMATICO' && (
                <Alert tone="warn">{PRECISAO_INFO[imovel.precisao].bloqueio === 'COM_AVISO' ? 'Posição aproximada: confira antes de usar no bloqueio.' : 'Posição imprecisa: confirme em campo antes do bloqueio.'}</Alert>
              )}
              {podePosicionar && (podeEditar || imovel?.campo || imovelAPosicionar?.id === selImovel) && (
                <Button size="sm" variant="secondary" id="terr-posicionar" onClick={() => setFerramenta('posicionar')}>
                  <Crosshair className="h-4 w-4" /> Marcar no mapa
                </Button>
              )}
            </CardBody>
          </Card>
        )}
      </div>

      <Dialog
        open={!!desativar}
        onOpenChange={(o) => !o && setDesativar(null)}
        title="Desativar o quarteirão"
        description="Os imóveis ligados a ele ficam sem quarteirão até a malha ser corrigida."
        footer={
          <Button
            variant="danger"
            onClick={async () => {
              const motivo = (document.getElementById('terr-desativar-motivo') as HTMLTextAreaElement | null)?.value ?? '';
              try {
                await api.post(`/territorio/quarteiroes/${desativar}/desativar`, { reason: motivo });
                toast.success('Quarteirão desativado.');
                setDesativar(null);
                setRascunho(null);
                setFerramenta('navegar');
                setSelQ(null);
                await camadas.reload();
                onAlterado?.();
              } catch (err) {
                toast.error(errorMessage(err));
              }
            }}
          >
            Desativar
          </Button>
        }
      >
        <Field label="Motivo" htmlFor="terr-desativar-motivo">
          <Textarea id="terr-desativar-motivo" rows={3} />
        </Field>
      </Dialog>
    </div>
  );
}
