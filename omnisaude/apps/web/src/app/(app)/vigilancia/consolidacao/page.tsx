'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { AbaConciliacao } from '@/components/consolidacao/conciliacao';
import { AbaContingencia } from '@/components/consolidacao/contingencia';
import { AbaDiagrama } from '@/components/consolidacao/diagrama';
import { AbaImportacao } from '@/components/consolidacao/importacao';
import { AbaNegativa } from '@/components/consolidacao/negativa';
import { AbaSurtos } from '@/components/consolidacao/surtos';
import type { AbaConsolidacao } from '@/components/consolidacao/types';
import { PageHeader } from '@/components/ui/card';
import { Alert } from '@/components/ui/misc';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { useSession } from '@/lib/session';

/**
 * Consolidação e surtos (VIG-1c): importação das exportações oficiais e conciliação (`vigilancia.importar`), diagrama
 * de controle, contingência e grade da notificação negativa (`vigilancia.resumo` ou `vigilancia.painel`; as ações pedem
 * `vigilancia.consolidacao` ou `vigilancia.contingencia`) e surtos (`vigilancia.surto`).
 */
function ConsolidacaoConteudo() {
  const session = useSession();
  const params = useSearchParams();
  const importa = session.can('vigilancia.importar');
  const le = session.can('vigilancia.resumo', 'vigilancia.painel');
  const surtos = session.can('vigilancia.surto');
  const abas = useMemo(
    () =>
      (
        [
          { value: 'importacao', label: 'Importação', ok: importa },
          { value: 'conciliacao', label: 'Conciliação', ok: importa },
          { value: 'diagrama', label: 'Diagrama de controle', ok: le },
          { value: 'contingencia', label: 'Contingência', ok: le },
          { value: 'surtos', label: 'Surtos', ok: surtos },
          { value: 'negativa', label: 'Notificação negativa', ok: le },
        ] satisfies { value: AbaConsolidacao; label: string; ok: boolean }[]
      ).filter((a) => a.ok),
    [importa, le, surtos],
  );
  const [tab, setTab] = useState(params.get('aba') ?? '');
  if (!abas.length) return <Alert tone="warn">Seu papel não tem acesso à consolidação e aos surtos.</Alert>;
  const atual = abas.some((a) => a.value === tab) ? tab : abas[0]!.value;
  return (
    <div className="space-y-4">
      <PageHeader title="Consolidação e surtos" description="Exportações oficiais conciliadas com as notificações, diagrama de controle, plano de contingência, surtos e notificação negativa das unidades." />
      <Tabs value={atual} onValueChange={setTab} tabs={abas.map(({ value, label }) => ({ value, label }))}>
        {importa && (
          <TabPanel value="importacao" className="pt-3">
            <AbaImportacao />
          </TabPanel>
        )}
        {importa && (
          <TabPanel value="conciliacao" className="pt-3">
            <AbaConciliacao podeEditarTerritorio={session.can('territorio.editar')} />
          </TabPanel>
        )}
        {le && (
          <TabPanel value="diagrama" className="pt-3">
            <AbaDiagrama podeConfigurar={session.can('vigilancia.consolidacao')} />
          </TabPanel>
        )}
        {le && (
          <TabPanel value="contingencia" className="pt-3">
            <AbaContingencia podeAgir={session.can('vigilancia.contingencia')} />
          </TabPanel>
        )}
        {surtos && (
          <TabPanel value="surtos" className="pt-3">
            <AbaSurtos />
          </TabPanel>
        )}
        {le && (
          <TabPanel value="negativa" className="pt-3">
            <AbaNegativa podeConfigurar={session.can('vigilancia.consolidacao')} />
          </TabPanel>
        )}
      </Tabs>
    </div>
  );
}

export default function ConsolidacaoPage() {
  return (
    <Suspense>
      <ConsolidacaoConteudo />
    </Suspense>
  );
}
