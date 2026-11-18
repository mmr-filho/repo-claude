'use client';

import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { NegativaGrade } from './negativa-grade';
import { secaoInicial, type SecaoNegativa } from './negativa-regras';
import { NegativaUnidades } from './negativa-unidades';
import { ParametrosVigilancia } from './parametros-vigilancia';

/**
 * Grade da notificação negativa (unidades × semanas: silenciosas, só negativas, % por semana com a meta e regularidade
 * do município) e, para a vigilância (`vigilancia.consolidacao`), anular atesto, atestar em nome da unidade e a
 * configuração das unidades notificantes e dos responsáveis. Com `vigilancia.catalogo` (`podeParametros`), os
 * parâmetros da semana 27: prazo e meta da negativa, semanas incompletas, validade da prévia e evento inusitado.
 * `?secao=unidades` ou `?secao=parametros` na URL abre a seção (o atalho da gestão da vigilância usa o segundo).
 */
export function AbaNegativa({ podeConfigurar, podeParametros = false }: { podeConfigurar: boolean; podeParametros?: boolean }) {
  const params = useSearchParams();
  const abas: { value: SecaoNegativa; label: string }[] = [
    { value: 'grade', label: 'Grade das unidades' },
    ...(podeConfigurar ? [{ value: 'unidades' as const, label: 'Unidades notificantes e responsáveis' }] : []),
    ...(podeParametros ? [{ value: 'parametros' as const, label: 'Prazos e parâmetros' }] : []),
  ];
  const [secao, setSecao] = useState(() =>
    secaoInicial(
      params?.get('secao'),
      abas.map((a) => a.value),
    ),
  );
  if (!podeConfigurar && !podeParametros) return <NegativaGrade podeConfigurar={false} />;
  return (
    <Tabs aria-label="Seções da notificação negativa" value={secao} onValueChange={setSecao} tabs={abas}>
      <TabPanel value="grade">
        <NegativaGrade podeConfigurar={podeConfigurar} />
      </TabPanel>
      {podeConfigurar && (
        <TabPanel value="unidades">
          <NegativaUnidades />
        </TabPanel>
      )}
      {podeParametros && (
        <TabPanel value="parametros">
          <ParametrosVigilancia />
        </TabPanel>
      )}
    </Tabs>
  );
}
