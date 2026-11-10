'use client';

import { ROTULO_NIVEL_TERRITORIO, type NivelTerritorio } from '@omnisaude/shared';
import { useMemo } from 'react';
import type { Bairro, Localidade } from '@/components/territorio/types';
import { Field, Select } from '@/components/ui/input';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { opcoesDeAgravo, type CondicaoDoCatalogo, type OpcaoAgravo } from './diagrama-agravos';

/**
 * Agravos dos seletores: do catálogo vigente do tenant para quem o lê (vigilância e quem notifica); para o gestor,
 * que só tem o resumo, os grupos da tabela de agravos do Sinan.
 */
export function useOpcoesDeAgravo(): { opcoes: OpcaoAgravo[]; carregando: boolean } {
  const session = useSession();
  const podeCatalogo = session.can('notificacao.registrar', 'vigilancia.painel');
  const catalogo = useApi<{ condicoes: CondicaoDoCatalogo[] }>(podeCatalogo ? '/vigilancia/catalogo/vigente' : null);
  const opcoes = useMemo(() => opcoesDeAgravo(catalogo.data?.condicoes ?? null), [catalogo.data]);
  return { opcoes, carregando: podeCatalogo && catalogo.loading && !catalogo.data };
}

/** Seletor de agravo (arboviroses no topo). `vazio` acrescenta a opção "Todos". */
export function SeletorAgravo({ id, valor, onChange, opcoes, vazio, rotulo = 'Agravo' }: { id: string; valor: string; onChange: (grupo: string) => void; opcoes: OpcaoAgravo[]; vazio?: string; rotulo?: string }) {
  const arbo = opcoes.filter((o) => ['dengue', 'chikungunya', 'zika'].includes(o.grupo));
  const demais = opcoes.filter((o) => !arbo.includes(o));
  // O grupo escolhido antes de o catálogo carregar continua visível.
  const fora = valor && !opcoes.some((o) => o.grupo === valor);
  return (
    <Field label={rotulo} htmlFor={id}>
      <Select id={id} value={valor} onChange={(e) => onChange(e.target.value)}>
        {vazio !== undefined && <option value="">{vazio}</option>}
        {fora && <option value={valor}>{valor}</option>}
        {arbo.length > 0 && (
          <optgroup label="Arboviroses">
            {arbo.map((o) => (
              <option key={o.grupo} value={o.grupo}>
                {o.nome}
              </option>
            ))}
          </optgroup>
        )}
        <optgroup label="Demais agravos">
          {demais.map((o) => (
            <option key={o.grupo} value={o.grupo}>
              {o.nome}
            </option>
          ))}
        </optgroup>
      </Select>
    </Field>
  );
}

/** Localidades e bairros do território (só para quem lê o território; sem isso, só o município). */
export function useTerritorios(nivel: NivelTerritorio) {
  const pode = useSession().can('territorio.ler');
  // As localidades também dão o nome dos grupos de bairros.
  const localidades = useApi<Localidade[]>(pode && nivel !== 'MUNICIPIO' ? '/territorio/localidades' : null);
  const bairros = useApi<Bairro[]>(pode && nivel === 'BAIRRO' ? '/territorio/bairros' : null);
  return { pode, localidades: localidades.data ?? [], bairros: bairros.data ?? [], carregando: localidades.loading || bairros.loading, erro: localidades.error ?? bairros.error };
}

/** Nome do território escolhido, pela lista do seletor ("Município" no nível do município). */
export function nomeDoTerritorio(t: ReturnType<typeof useTerritorios>, nivel: NivelTerritorio, territorio: string | null): string {
  if (nivel === 'MUNICIPIO') return 'Município';
  const achado = nivel === 'BAIRRO' ? t.bairros.find((b) => b.id === territorio)?.name : t.localidades.find((l) => l.id === territorio)?.name;
  return achado ?? (nivel === 'BAIRRO' ? 'Bairro' : 'Localidade');
}

/** Nível (município, localidade ou bairro) e o território do nível. */
export function SeletorTerritorio({
  prefixo,
  nivel,
  territorio,
  territorios: t,
  onChange,
}: {
  prefixo: string;
  nivel: NivelTerritorio;
  territorio: string | null;
  /** `useTerritorios(nivel)` de quem usa o seletor (o mesmo resultado dá o nome do território escolhido). */
  territorios: ReturnType<typeof useTerritorios>;
  onChange: (v: { nivel: NivelTerritorio; territorio: string | null }) => void;
}) {
  const porLocalidade = useMemo(() => {
    const nomes = new Map(t.localidades.map((l) => [l.id, l.name]));
    const grupos = new Map<string, Bairro[]>();
    for (const b of t.bairros) grupos.set(b.localityId, [...(grupos.get(b.localityId) ?? []), b]);
    return [...grupos].map(([id, lista]) => ({ id, nome: nomes.get(id) ?? 'Localidade', lista })).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  }, [t.localidades, t.bairros]);
  const niveis: NivelTerritorio[] = t.pode ? ['MUNICIPIO', 'LOCALIDADE', 'BAIRRO'] : ['MUNICIPIO'];
  return (
    <>
      <Field label="Nível" htmlFor={`${prefixo}-nivel`}>
        <Select id={`${prefixo}-nivel`} value={nivel} onChange={(e) => onChange({ nivel: e.target.value as NivelTerritorio, territorio: null })}>
          {niveis.map((n) => (
            <option key={n} value={n}>
              {ROTULO_NIVEL_TERRITORIO[n]}
            </option>
          ))}
        </Select>
      </Field>
      {nivel !== 'MUNICIPIO' && (
        <Field label={nivel === 'BAIRRO' ? 'Bairro' : 'Localidade'} htmlFor={`${prefixo}-territorio`} error={t.erro}>
          <Select id={`${prefixo}-territorio`} value={territorio ?? ''} onChange={(e) => onChange({ nivel, territorio: e.target.value || null })} disabled={t.carregando}>
            <option value="">{t.carregando ? 'Carregando…' : nivel === 'BAIRRO' ? 'Escolha o bairro' : 'Escolha a localidade'}</option>
            {nivel === 'LOCALIDADE'
              ? t.localidades.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.code} · {l.name}
                  </option>
                ))
              : porLocalidade.map((g) => (
                  <optgroup key={g.id} label={g.nome}>
                    {g.lista.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
          </Select>
        </Field>
      )}
    </>
  );
}
