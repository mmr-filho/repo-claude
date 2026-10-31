'use client';

import 'leaflet/dist/leaflet.css';
import type { CircleMarker, LayerGroup, Map as LeafletMap } from 'leaflet';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/cn';

export interface PontoMapa {
  id: string;
  latitude: number;
  longitude: number;
  titulo: string;
  subtitulo?: string;
  tom: 'green' | 'amber' | 'red' | 'slate' | 'blue';
}

const COR: Record<PontoMapa['tom'], string> = { green: '#059669', amber: '#d97706', red: '#dc2626', slate: '#64748b', blue: '#1567ed' };

/**
 * Mapa do território (Leaflet + OpenStreetMap): um ponto por domicílio, colorido pela última visita. Sem
 * internet o fundo não carrega, mas os pontos e a seleção continuam funcionando.
 */
export function TerritoryMap({
  pontos,
  selecionado,
  onSelect,
  posicao,
  className,
}: {
  pontos: PontoMapa[];
  selecionado?: string | null;
  onSelect?: (id: string) => void;
  posicao?: { latitude: number; longitude: number } | null;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletMap | null>(null);
  const camada = useRef<LayerGroup | null>(null);
  const marcadores = useRef(new Map<string, CircleMarker>());
  const ajustado = useRef(false);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    let cancelado = false;
    void (async () => {
      const L = await import('leaflet');
      if (cancelado || !ref.current || map.current) return;
      map.current = L.map(ref.current, { zoomControl: true, attributionControl: true }).setView([-15.78, -47.93], 4);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map.current);
      camada.current = L.layerGroup().addTo(map.current);
      desenhar(L);
    })();
    return () => {
      cancelado = true;
      map.current?.remove();
      map.current = null;
      camada.current = null;
      marcadores.current.clear();
      ajustado.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function desenhar(L: typeof import('leaflet')) {
    if (!map.current || !camada.current) return;
    camada.current.clearLayers();
    marcadores.current.clear();
    const coords: [number, number][] = [];
    for (const p of pontos) {
      const ativo = p.id === selecionado;
      const m = L.circleMarker([p.latitude, p.longitude], { radius: ativo ? 11 : 8, color: ativo ? '#0f172a' : '#ffffff', weight: ativo ? 3 : 2, fillColor: COR[p.tom], fillOpacity: 0.9 });
      m.bindTooltip(`<strong>${escapar(p.titulo)}</strong>${p.subtitulo ? `<br>${escapar(p.subtitulo)}` : ''}`, { direction: 'top', offset: [0, -8] });
      m.on('click', () => onSelectRef.current?.(p.id));
      m.addTo(camada.current);
      marcadores.current.set(p.id, m);
      coords.push([p.latitude, p.longitude]);
    }
    if (posicao) {
      L.circleMarker([posicao.latitude, posicao.longitude], { radius: 7, color: '#ffffff', weight: 2, fillColor: COR.blue, fillOpacity: 1 }).bindTooltip('Você está aqui').addTo(camada.current);
      coords.push([posicao.latitude, posicao.longitude]);
    }
    if (!ajustado.current && coords.length) {
      map.current.fitBounds(L.latLngBounds(coords), { padding: [30, 30], maxZoom: 17 });
      ajustado.current = true;
    }
    setTimeout(() => map.current?.invalidateSize(), 50);
  }

  useEffect(() => {
    if (!map.current) return;
    void import('leaflet').then((L) => desenhar(L));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pontos, selecionado, posicao]);

  useEffect(() => {
    if (selecionado && map.current) {
      const m = marcadores.current.get(selecionado);
      if (m) map.current.panTo(m.getLatLng());
    }
  }, [selecionado]);

  return <div ref={ref} className={cn('h-[60dvh] min-h-[320px] w-full overflow-hidden rounded-xl border border-slate-200 bg-slate-100', className)} role="application" aria-label="Mapa do território" />;
}

function escapar(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}
