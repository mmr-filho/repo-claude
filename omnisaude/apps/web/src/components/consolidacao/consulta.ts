'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, errorMessage } from '@/lib/api';

/** Erro de uma leitura, com o status HTTP e o código da API (ex.: 403 AGRAVO_SIGILOSO). */
export interface ErroDaConsulta {
  mensagem: string;
  status: number | null;
  codigo: string | null;
}

/** O erro da leitura como a tela usa (o `useApi` de lib/hooks só guarda o texto). */
export function erroDaConsulta(err: unknown): ErroDaConsulta {
  return err instanceof ApiError ? { mensagem: errorMessage(err), status: err.status, codigo: err.code ?? null } : { mensagem: errorMessage(err), status: null, codigo: null };
}

/** Recusa por sigilo do agravo (403 AGRAVO_SIGILOSO): a tela explica e pede outro agravo, sem tratar como falha. */
export const recusaPorSigilo = (e: ErroDaConsulta | null) => !!e && e.status === 403 && e.codigo === 'AGRAVO_SIGILOSO';

/**
 * Como o `useApi`, mas guarda o status e o código do erro (a tela trata a recusa por sigilo à parte). path null =
 * não buscar.
 */
export function useConsulta<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [erro, setErro] = useState<ErroDaConsulta | null>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    if (!path) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await api.get<T>(path);
      if (mine === seq.current) {
        setData(res);
        setErro(null);
      }
    } catch (err) {
      if (mine === seq.current) setErro(erroDaConsulta(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, erro, loading, reload: load };
}
