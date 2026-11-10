'use client';

import { useState } from 'react';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { NegativaGrade } from './negativa-grade';
import { NegativaUnidades } from './negativa-unidades';

/**
 * Grade da notificação negativa (unidades × semanas: silenciosas, só negativas, % por semana com a meta e regularidade
 * do município) e, para a vigilância (`vigilancia.consolidacao`), anular atesto, atestar em nome da unidade e a
 * configuração das unidades notificantes e dos responsáveis.
 */
export function AbaNegativa({ podeConfigurar }: { podeConfigurar: boolean }) {
  const [secao, setSecao] = useState('grade');
  if (!podeConfigurar) return <NegativaGrade podeConfigurar={false} />;
  return (
    <Tabs
      value={secao}
      onValueChange={setSecao}
      tabs={[
        { value: 'grade', label: 'Grade das unidades' },
        { value: 'unidades', label: 'Unidades notificantes e responsáveis' },
      ]}
    >
      <TabPanel value="grade">
        <NegativaGrade podeConfigurar />
      </TabPanel>
      <TabPanel value="unidades">
        <NegativaUnidades />
      </TabPanel>
    </Tabs>
  );
}
