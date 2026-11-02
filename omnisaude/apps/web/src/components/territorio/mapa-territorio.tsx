'use client';

import 'leaflet/dist/leaflet.css';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';
import type { GeoJSON as CamadaGeoJSON, LayerGroup, Map as LeafletMap } from 'leaflet';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { COR_PRECISAO, type CamadasMapa, type Geometria } from './types';

type L = typeof import('leaflet');

export interface PontoCaso {
  id: string;
  lat: number;
  lng: number;
  cor: string;
  titulo: string;
  /** Precisão baixa: contorno tracejado (não serve ao bloqueio sem confirmar em campo). */
  incerto?: boolean;
}

export type ModoMapa = 'navegar' | 'clicar' | 'desenhar' | 'editar';

/**
 * Mapa do território (Leaflet + OpenStreetMap, editor com Leaflet-Geoman): localidades e bairros, quarteirões com o
 * número, imóveis coloridos pela precisão da posição, casos notificados, raio do bloqueio e o desenho ou a edição do
 * contorno de um quarteirão. A posição dos imóveis e dos casos fica no navegador: o fundo do mapa vem do
 * OpenStreetMap, que só recebe as coordenadas dos ladrilhos.
 */
export function MapaTerritorio({
  camadas,
  casos,
  destaque,
  raio,
  quarteiraoSelecionado,
  imovelSelecionado,
  modo = 'navegar',
  geometriaEdicao,
  centroInicial,
  onMover,
  onClicar,
  onQuarteirao,
  onImovel,
  onCaso,
  onGeometria,
  className,
}: {
  camadas: CamadasMapa | null;
  casos?: PontoCaso[];
  destaque?: string[];
  raio?: { lat: number; lng: number; metros: number } | null;
  quarteiraoSelecionado?: string | null;
  imovelSelecionado?: string | null;
  modo?: ModoMapa;
  geometriaEdicao?: Geometria | null;
  centroInicial?: [number, number] | null;
  onMover?: (bbox: [number, number, number, number]) => void;
  onClicar?: (lat: number, lng: number) => void;
  onQuarteirao?: (id: string) => void;
  onImovel?: (id: string) => void;
  onCaso?: (id: string) => void;
  onGeometria?: (g: Geometria) => void;
  className?: string;
}) {
  const div = useRef<HTMLDivElement>(null);
  const mapa = useRef<LeafletMap | null>(null);
  const lib = useRef<L | null>(null);
  const grupos = useRef<Record<'base' | 'quarteiroes' | 'rotulos' | 'imoveis' | 'casos' | 'raio' | 'edicao', LayerGroup> | null>(null);
  const ajustado = useRef(false);
  const [pronto, setPronto] = useState(false);
  const cb = useRef({ onMover, onClicar, onQuarteirao, onImovel, onCaso, onGeometria, modo });
  cb.current = { onMover, onClicar, onQuarteirao, onImovel, onCaso, onGeometria, modo };

  useEffect(() => {
    let cancelado = false;
    let espera: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      const L = await import('leaflet');
      // O Geoman é um script que usa o L global (o Leaflet o define ao carregar no navegador).
      (window as unknown as { L: L }).L = (L as unknown as { default?: L }).default ?? L;
      await import('@geoman-io/leaflet-geoman-free');
      if (cancelado || !div.current || mapa.current) return;
      lib.current = L;
      const m = L.map(div.current, { zoomControl: true, attributionControl: true }).setView(centroInicial ?? [-15.78, -47.93], centroInicial ? 15 : 4);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 20, maxNativeZoom: 19, attribution: '© OpenStreetMap' }).addTo(m);
      grupos.current = {
        base: L.layerGroup().addTo(m),
        quarteiroes: L.layerGroup().addTo(m),
        rotulos: L.layerGroup(),
        imoveis: L.layerGroup().addTo(m),
        casos: L.layerGroup().addTo(m),
        raio: L.layerGroup().addTo(m),
        edicao: L.layerGroup().addTo(m),
      };
      const avisar = () => {
        if (cancelado || mapa.current !== m) return;
        const b = m.getBounds();
        cb.current.onMover?.([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
      };
      m.on('moveend', () => {
        clearTimeout(espera);
        espera = setTimeout(avisar, 250);
      });
      m.on('zoomend', () => {
        if (!grupos.current) return;
        if (m.getZoom() >= 17) grupos.current.rotulos.addTo(m);
        else grupos.current.rotulos.remove();
      });
      m.on('click', (e) => {
        if (cb.current.modo === 'clicar') cb.current.onClicar?.(e.latlng.lat, e.latlng.lng);
      });
      m.on('pm:create', (e) => {
        const camada = (e as unknown as { layer: CamadaGeoJSON }).layer;
        const g = (camada.toGeoJSON() as unknown as { geometry: Geometria }).geometry;
        camada.remove();
        cb.current.onGeometria?.(g);
      });
      mapa.current = m;
      setPronto(true);
      avisar();
    })();
    return () => {
      cancelado = true;
      const m = mapa.current;
      mapa.current = null;
      if (m) {
        // Ouvintes fora antes de remover: parar uma animação dispara 'moveend', e o aviso atrasado leria o mapa desmontado.
        m.off();
        m.eachLayer((l) => {
          l.closeTooltip();
          l.off();
        });
        (m as LeafletMap & { pm?: { disableDraw: () => void } }).pm?.disableDraw();
        m.stop();
        m.remove();
      }
      clearTimeout(espera);
      grupos.current = null;
      ajustado.current = false;
    };
    // O mapa é criado uma vez; o centro inicial só vale na criação.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Localidades, bairros e quarteirões.
  useEffect(() => {
    const L = lib.current;
    const m = mapa.current;
    const g = grupos.current;
    if (!pronto || !L || !m || !g) return;
    g.base.clearLayers();
    g.quarteiroes.clearLayers();
    g.rotulos.clearLayers();
    if (!camadas) return;
    for (const l of camadas.localidades) if (l.geometry) L.geoJSON(l.geometry as never, { style: { color: '#475569', weight: 2, dashArray: '6 6', fill: false }, interactive: false }).addTo(g.base);
    for (const b of camadas.bairros) if (b.geometry) L.geoJSON(b.geometry as never, { style: { color: '#7c3aed', weight: 1.5, dashArray: b.official ? undefined : '4 4', fill: false }, interactive: false }).addTo(g.base);
    const realce = new Set(destaque ?? []);
    for (const q of camadas.quarteiroes) {
      const selecionado = q.id === quarteiraoSelecionado;
      const camada = L.geoJSON(q.geometry as never, {
        style: {
          color: selecionado ? '#1567ed' : realce.has(q.id) ? '#dc2626' : '#334155',
          weight: selecionado ? 3 : realce.has(q.id) ? 2.5 : 1,
          fillColor: realce.has(q.id) ? '#fecaca' : selecionado ? '#bfdbfe' : '#e2e8f0',
          fillOpacity: realce.has(q.id) || selecionado ? 0.55 : 0.35,
        },
      });
      camada.on('click', (e) => {
        if (cb.current.modo !== 'navegar') return;
        L.DomEvent.stopPropagation(e);
        cb.current.onQuarteirao?.(q.id);
      });
      camada.bindTooltip(`Quarteirão ${q.number} · ${q.imoveis} imóvel(is)`, { sticky: true });
      camada.addTo(g.quarteiroes);
      L.marker([q.centerLat, q.centerLng], { icon: L.divIcon({ className: 'rotulo-quarteirao', html: `<span>${q.number}</span>`, iconSize: [40, 16] }), interactive: false }).addTo(g.rotulos);
    }
    if (m.getZoom() >= 17) g.rotulos.addTo(m);
    if (!ajustado.current && camadas.quarteiroes.length && !centroInicial) {
      const b = L.latLngBounds(camadas.quarteiroes.map((q) => [q.centerLat, q.centerLng] as [number, number]));
      m.fitBounds(b.pad(0.1), { maxZoom: 17 });
      ajustado.current = true;
    }
  }, [pronto, camadas, destaque, quarteiraoSelecionado, centroInicial]);

  // Imóveis (sem moradores): cor pela precisão da posição.
  useEffect(() => {
    const L = lib.current;
    const g = grupos.current;
    if (!pronto || !L || !g) return;
    g.imoveis.clearLayers();
    for (const h of camadas?.imoveis ?? []) {
      const sel = h.id === imovelSelecionado;
      const c = L.circleMarker([h.lat, h.lng], { radius: sel ? 8 : 5, color: sel ? '#1567ed' : '#ffffff', weight: sel ? 3 : 1, fillColor: COR_PRECISAO[h.precisao ?? ''] ?? '#64748b', fillOpacity: 0.95 });
      c.bindTooltip(`${h.endereco || 'Imóvel'}${h.sequencia ? ` · seq. ${h.sequencia}` : ''}`);
      c.on('click', (e) => {
        if (cb.current.modo !== 'navegar') return;
        L.DomEvent.stopPropagation(e);
        cb.current.onImovel?.(h.id);
      });
      c.addTo(g.imoveis);
    }
  }, [pronto, camadas, imovelSelecionado]);

  // Casos notificados (mapa da vigilância).
  useEffect(() => {
    const L = lib.current;
    const m = mapa.current;
    const g = grupos.current;
    if (!pronto || !L || !m || !g) return;
    g.casos.clearLayers();
    for (const p of casos ?? []) {
      const c = L.circleMarker([p.lat, p.lng], { radius: 7, color: '#111827', weight: 1.5, dashArray: p.incerto ? '3 3' : undefined, fillColor: p.cor, fillOpacity: 0.9 });
      c.bindTooltip(p.titulo);
      c.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        cb.current.onCaso?.(p.id);
      });
      c.addTo(g.casos);
    }
    if (!ajustado.current && casos?.length && !camadas?.quarteiroes.length) {
      m.fitBounds(L.latLngBounds(casos.map((p) => [p.lat, p.lng] as [number, number])).pad(0.2), { maxZoom: 16 });
      ajustado.current = true;
    }
  }, [pronto, casos, camadas]);

  // Raio do bloqueio.
  useEffect(() => {
    const L = lib.current;
    const g = grupos.current;
    if (!pronto || !L || !g) return;
    g.raio.clearLayers();
    if (!raio) return;
    L.circle([raio.lat, raio.lng], { radius: raio.metros, color: '#dc2626', weight: 2, dashArray: '6 4', fillOpacity: 0.05, interactive: false }).addTo(g.raio);
    L.circleMarker([raio.lat, raio.lng], { radius: 5, color: '#dc2626', fillColor: '#dc2626', fillOpacity: 1, interactive: false }).addTo(g.raio);
  }, [pronto, raio]);

  // Modo: clicar (raio, posição do imóvel), desenhar ou editar o contorno.
  useEffect(() => {
    const L = lib.current;
    const m = mapa.current as (LeafletMap & { pm?: { enableDraw: (s: string, o: object) => void; disableDraw: () => void } }) | null;
    const g = grupos.current;
    if (!pronto || !L || !m || !g || !m.pm) return;
    m.pm.disableDraw();
    g.edicao.clearLayers();
    m.getContainer().style.cursor = modo === 'clicar' || modo === 'desenhar' ? 'crosshair' : '';
    if (modo === 'desenhar') m.pm.enableDraw('Polygon', { snappable: true, snapDistance: 15, allowSelfIntersection: false, finishOn: 'dblclick' });
    if (modo === 'editar' && geometriaEdicao) {
      const camada = L.geoJSON(geometriaEdicao as never, { style: { color: '#1567ed', weight: 3, fillOpacity: 0.2 } });
      camada.addTo(g.edicao);
      camada.eachLayer((l) => {
        const pm = (l as unknown as { pm?: { enable: (o: object) => void } }).pm;
        pm?.enable({ allowSelfIntersection: false, snappable: true, snapDistance: 15 });
        l.on('pm:edit', () => cb.current.onGeometria?.(((l as unknown as CamadaGeoJSON).toGeoJSON() as unknown as { geometry: Geometria }).geometry));
      });
    }
  }, [pronto, modo, geometriaEdicao]);

  return <div ref={div} className={cn('z-0 h-[560px] w-full overflow-hidden rounded-lg border border-slate-200', className)} role="region" aria-label="Mapa do território" />;
}
