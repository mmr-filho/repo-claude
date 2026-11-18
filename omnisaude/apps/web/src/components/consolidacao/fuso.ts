'use client';

import { useCallback } from 'react';
import { fmtDateTimeTz, fmtDateTz } from '@/lib/format';
import { useSession } from '@/lib/session';

/*
 * Fuso das telas da consolidação e dos surtos: o da instituição (`tenant.timeZone`), o mesmo em que a API calcula o
 * prazo da negativa, os prazos do surto e o "hoje". O `fmtDateTime` de lib/format fica no fuso de Brasília para as
 * outras telas.
 */

/** Fuso usado enquanto a sessão carrega (e o padrão da instituição nova). */
export const FUSO_PADRAO = 'America/Sao_Paulo';

/** Fuso da instituição. */
export function useFuso(): string {
  return useSession().me?.tenant.timeZone ?? FUSO_PADRAO;
}

/** Formatadores de instante no fuso da instituição: data e hora, e só a data. */
export function useDataHora(): { dataHora: (v: string | Date | null | undefined) => string; data: (v: string | Date | null | undefined) => string; fuso: string } {
  const fuso = useFuso();
  const dataHora = useCallback((v: string | Date | null | undefined) => fmtDateTimeTz(v, fuso), [fuso]);
  const data = useCallback((v: string | Date | null | undefined) => fmtDateTz(v, fuso), [fuso]);
  return { dataHora, data, fuso };
}
