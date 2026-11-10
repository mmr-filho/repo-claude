'use client';

import { CATEGORIA_SURTO, LOCAL_INICIAL_SURTO, SINDROMES_SURTO, type CategoriaSurto, type ListaUnidadesNotificantes, type UnidadeRef } from '@omnisaude/shared';
import { useMemo } from 'react';
import { Field, Input, Select } from '@/components/ui/input';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { OpcaoAgravo } from './diagrama-agravos';
import { SeletorAgravo, useTerritorios } from './diagrama-seletores';
import { ROTULO_ZONA, usaGrupo, usaSindrome, type FormLocal, type FormSurto } from './surto-regras';

/*
 * Campos da notificação de surto usados no formulário novo e na ficha do surto aberto: agravo (pela categoria),
 * campos 17 a 19 da ficha (primeiros sintomas, nº de casos, local inicial), local de ocorrência e unidade notificante.
 */

const DICA_CATEGORIA: Record<CategoriaSurto, string> = {
  DA_LISTA: 'Agravo da lista nacional. O surto não substitui a notificação individual dos casos.',
  DTA: 'Doença transmitida por alimento: a ficha de DTA abre o bloco de entrevistados, alimento e agente.',
  SINDROMICO: 'Agravo inusitado: a síndrome dá o código do Sinan.',
  FORA_DA_LISTA: 'Doença fora da lista nacional: informe o CID.',
};

type CamposDeAgravo = Pick<FormSurto, 'categoria' | 'grupo' | 'sindrome' | 'cid' | 'agente'>;

/** Categoria e agravo do surto (catálogo, síndrome ou CID, conforme a categoria) e o agente etiológico. */
export function CamposAgravo({ prefixo, f, set, opcoes, disabled }: { prefixo: string; f: CamposDeAgravo; set: (patch: Partial<CamposDeAgravo>) => void; opcoes: OpcaoAgravo[]; disabled?: boolean }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Field label="Categoria" htmlFor={`${prefixo}-categoria`} hint={DICA_CATEGORIA[f.categoria]}>
        <Select id={`${prefixo}-categoria`} disabled={disabled} value={f.categoria} onChange={(e) => set({ categoria: e.target.value as CategoriaSurto })}>
          {(Object.keys(CATEGORIA_SURTO) as CategoriaSurto[]).map((c) => (
            <option key={c} value={c}>
              {CATEGORIA_SURTO[c]}
            </option>
          ))}
        </Select>
      </Field>
      {usaGrupo(f.categoria) &&
        (disabled ? (
          <Field label="Agravo" htmlFor={`${prefixo}-grupo`}>
            <Input id={`${prefixo}-grupo`} disabled value={opcoes.find((o) => o.grupo === f.grupo)?.nome ?? f.grupo} />
          </Field>
        ) : (
          <SeletorAgravo id={`${prefixo}-grupo`} rotulo="Agravo (catálogo)" valor={f.grupo} opcoes={opcoes} vazio={f.categoria === 'DTA' ? 'Nenhum: só o CID' : 'Escolha o agravo'} onChange={(grupo) => set({ grupo })} />
        ))}
      {usaSindrome(f.categoria) && (
        <Field label="Síndrome" htmlFor={`${prefixo}-sindrome`} hint="Código da síndrome de fonte secundária: confira no Sinan Net.">
          <Select id={`${prefixo}-sindrome`} disabled={disabled} value={f.sindrome} onChange={(e) => set({ sindrome: e.target.value })}>
            <option value="">Escolha a síndrome</option>
            {Object.entries(SINDROMES_SURTO).map(([chave, s]) => (
              <option key={chave} value={chave}>
                {s.nome}
                {s.codigo ? ` (${s.codigo})` : ''}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label={f.categoria === 'FORA_DA_LISTA' ? 'CID-10' : 'CID-10 (opcional)'} htmlFor={`${prefixo}-cid`} hint="Ex.: A05.9, J06. Vai para o ID_AGRAVO quando informado.">
        <Input id={`${prefixo}-cid`} disabled={disabled} maxLength={6} value={f.cid} onChange={(e) => set({ cid: e.target.value })} />
      </Field>
      <Field label="Agente etiológico (opcional)" htmlFor={`${prefixo}-agente`}>
        <Input id={`${prefixo}-agente`} disabled={disabled} maxLength={200} value={f.agente} onChange={(e) => set({ agente: e.target.value })} />
      </Field>
    </div>
  );
}

type CamposDaNotificacao = Pick<FormSurto, 'notificadoEm' | 'primeirosSintomasEm' | 'casos' | 'esp' | 'localInicial' | 'localInicialTexto'>;

/** Data da notificação, ESP e os campos 17 a 19 da ficha (primeiros sintomas do 1º caso, nº de casos, local inicial). */
export function CamposNotificacao({ prefixo, f, set, hoje, disabled }: { prefixo: string; f: CamposDaNotificacao; set: (patch: Partial<CamposDaNotificacao>) => void; hoje: string; disabled?: boolean }) {
  return (
    <div className="grid gap-3 md:grid-cols-3">
      <Field label="Data da notificação" htmlFor={`${prefixo}-notificado`}>
        <Input id={`${prefixo}-notificado`} type="date" max={hoje} disabled={disabled} value={f.notificadoEm} onChange={(e) => set({ notificadoEm: e.target.value })} />
      </Field>
      <Field label="17. Primeiros sintomas do 1º caso" htmlFor={`${prefixo}-sintomas`}>
        <Input id={`${prefixo}-sintomas`} type="date" max={f.notificadoEm || hoje} disabled={disabled} value={f.primeirosSintomasEm} onChange={(e) => set({ primeirosSintomasEm: e.target.value })} />
      </Field>
      <Field label="18. Nº de casos suspeitos/expostos" htmlFor={`${prefixo}-casos`}>
        <Input id={`${prefixo}-casos`} inputMode="numeric" disabled={disabled} value={f.casos} onChange={(e) => set({ casos: e.target.value.replace(/\D/g, '').slice(0, 7) })} />
      </Field>
      <Field label="19. Local inicial de ocorrência" htmlFor={`${prefixo}-local-inicial`} className="md:col-span-2">
        <Select id={`${prefixo}-local-inicial`} disabled={disabled} value={f.localInicial} onChange={(e) => set({ localInicial: e.target.value })}>
          <option value="">Escolha o local</option>
          {Object.entries(LOCAL_INICIAL_SURTO).map(([codigo, nome]) => (
            <option key={codigo} value={codigo}>
              {codigo} - {nome}
            </option>
          ))}
        </Select>
      </Field>
      {f.localInicial === '11' ? (
        <Field label="Qual local (outros)" htmlFor={`${prefixo}-local-texto`}>
          <Input id={`${prefixo}-local-texto`} disabled={disabled} maxLength={200} value={f.localInicialTexto} onChange={(e) => set({ localInicialTexto: e.target.value })} />
        </Field>
      ) : (
        <div />
      )}
      <label className="flex items-start gap-2 text-sm text-slate-700 md:col-span-3">
        <input type="checkbox" className="mt-0.5" disabled={disabled} checked={f.esp} onChange={(e) => set({ esp: e.target.checked })} />
        <span>
          Configura emergência de saúde pública (ESP): a comunicação imediata também vai à SES e ao MS (item 22 da Lista Nacional).
          <span className="block text-xs text-slate-500">Sem ESP, a comunicação imediata (24 h do conhecimento) é à SMS.</span>
        </span>
      </label>
    </div>
  );
}

/** Local de ocorrência do surto (campos 20 a 33): município, localidade, bairro, endereço, zona e coordenadas. */
export function CamposLocal({ prefixo, local, set, disabled }: { prefixo: string; local: FormLocal; set: (patch: Partial<FormLocal>) => void; disabled?: boolean }) {
  const t = useTerritorios('BAIRRO');
  const bairros = useMemo(
    () => (local.localidadeId ? t.bairros.filter((b) => b.localityId === local.localidadeId) : t.bairros).slice().sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')),
    [t.bairros, local.localidadeId],
  );
  return (
    <div className="grid gap-3 md:grid-cols-3">
      <Field label="Município de ocorrência (IBGE)" htmlFor={`${prefixo}-ibge`} hint="6 ou 7 dígitos; em branco = o da unidade.">
        <Input id={`${prefixo}-ibge`} inputMode="numeric" maxLength={7} disabled={disabled} value={local.municipioIbge} onChange={(e) => set({ municipioIbge: e.target.value.replace(/\D/g, '') })} />
      </Field>
      {t.pode && (
        <Field label="Localidade" htmlFor={`${prefixo}-localidade`}>
          <Select id={`${prefixo}-localidade`} disabled={disabled || t.carregando} value={local.localidadeId} onChange={(e) => set({ localidadeId: e.target.value, bairroId: '' })}>
            <option value="">{t.carregando ? 'Carregando…' : 'Não informada'}</option>
            {t.localidades.map((l) => (
              <option key={l.id} value={l.id}>
                {l.code} · {l.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {t.pode && (
        <Field label="Bairro" htmlFor={`${prefixo}-bairro`}>
          <Select id={`${prefixo}-bairro`} disabled={disabled || t.carregando} value={local.bairroId} onChange={(e) => set({ bairroId: e.target.value })}>
            <option value="">{t.carregando ? 'Carregando…' : 'Não informado'}</option>
            {bairros.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label="Endereço (logradouro e número)" htmlFor={`${prefixo}-endereco`} className="md:col-span-2">
        <Input id={`${prefixo}-endereco`} disabled={disabled} maxLength={200} value={local.endereco} onChange={(e) => set({ endereco: e.target.value })} />
      </Field>
      <Field label="Ponto de referência" htmlFor={`${prefixo}-referencia`}>
        <Input id={`${prefixo}-referencia`} disabled={disabled} maxLength={200} value={local.referencia} onChange={(e) => set({ referencia: e.target.value })} />
      </Field>
      <Field label="Zona" htmlFor={`${prefixo}-zona`}>
        <Select id={`${prefixo}-zona`} disabled={disabled} value={local.zona} onChange={(e) => set({ zona: e.target.value })}>
          <option value="">Não informada</option>
          {Object.entries(ROTULO_ZONA).map(([codigo, nome]) => (
            <option key={codigo} value={codigo}>
              {codigo} - {nome}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Latitude" htmlFor={`${prefixo}-lat`}>
        <Input id={`${prefixo}-lat`} inputMode="decimal" disabled={disabled} value={local.lat} onChange={(e) => set({ lat: e.target.value })} placeholder="-23,5505" />
      </Field>
      <Field label="Longitude" htmlFor={`${prefixo}-lng`}>
        <Input id={`${prefixo}-lng`} inputMode="decimal" disabled={disabled} value={local.lng} onChange={(e) => set({ lng: e.target.value })} placeholder="-46,6333" />
      </Field>
    </div>
  );
}

/**
 * Unidades que podem notificar o surto: a vigilância municipal (`vigilancia.consolidacao`, só o papel da vigilância
 * epidemiológica, que a API confere) escolhe entre as unidades ativas; o núcleo notifica só a unidade do contexto.
 */
export function useUnidadesDoSurto(): { opcoes: UnidadeRef[]; municipal: boolean; carregando: boolean } {
  const session = useSession();
  const municipal = session.can('vigilancia.consolidacao');
  const lista = useApi<ListaUnidadesNotificantes>(municipal ? '/vigilancia/unidades-notificantes' : null);
  const ctx = session.me?.context;
  const opcoes = useMemo(() => {
    const doContexto: UnidadeRef[] = ctx ? [{ id: ctx.unitId, nome: ctx.unitName, cnes: '' }] : [];
    if (!municipal) return doContexto;
    const ativas = (lista.data ?? []).filter((u) => u.ativa).map((u) => u.unidade);
    return ativas.some((u) => u.id === ctx?.unitId) ? ativas : [...doContexto, ...ativas];
  }, [ctx, municipal, lista.data]);
  return { opcoes, municipal, carregando: municipal && lista.loading };
}

/** Seletor da unidade notificante (fixo na unidade do contexto para o núcleo). */
export function CampoUnidade({ id, valor, onChange, unidades }: { id: string; valor: string; onChange: (id: string) => void; unidades: ReturnType<typeof useUnidadesDoSurto> }) {
  return (
    <Field label="Unidade notificante" htmlFor={id} hint={unidades.municipal ? undefined : 'O núcleo notifica surto da unidade em que está lotado.'}>
      <Select id={id} value={valor} disabled={!unidades.municipal || unidades.carregando} onChange={(e) => onChange(e.target.value)}>
        {!valor && <option value="">Escolha a unidade</option>}
        {!unidades.opcoes.some((u) => u.id === valor) && valor && <option value={valor}>Unidade da sugestão</option>}
        {unidades.opcoes.map((u) => (
          <option key={u.id} value={u.id}>
            {u.nome}
            {u.cnes ? ` (CNES ${u.cnes})` : ''}
          </option>
        ))}
      </Select>
    </Field>
  );
}
