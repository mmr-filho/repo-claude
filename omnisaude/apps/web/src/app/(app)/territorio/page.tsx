'use client';

import { useState } from 'react';
import { AbaConfiguracao, AbaImportar, AbaLocalidades, AbaPendencias } from '@/components/territorio/abas';
import { AbaMapa } from '@/components/territorio/aba-mapa';
import type { ImovelPendente, ResumoTerritorio } from '@/components/territorio/types';
import { PageHeader, Stat } from '@/components/ui/card';
import { Alert, Spinner } from '@/components/ui/misc';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

export default function TerritorioPage() {
  const session = useSession();
  const podeLer = session.can('territorio.ler');
  const podeEditar = session.can('territorio.editar');
  const podePosicionar = podeEditar || session.can('acs.campo');
  const [tab, setTab] = useState('mapa');
  const [versao, setVersao] = useState(0);
  const resumo = useApi<ResumoTerritorio>(podeLer ? '/territorio/resumo' : null, [versao]);
  const config = useApi<{ srcAceitos: { codigo: string; label: string }[] }>(podeEditar ? '/territorio/configuracoes' : null);
  const [aPosicionar, setAPosicionar] = useState<ImovelPendente | null>(null);
  const atualizar = () => setVersao((v) => v + 1);

  if (!podeLer) return <Alert tone="warn">Seu papel não tem acesso ao território.</Alert>;

  const r = resumo.data;
  const bons = r ? (r.porPrecisao.GPS_CAMPO ?? 0) + (r.porPrecisao.MAPA ?? 0) + (r.porPrecisao.ENDERECO ?? 0) : 0;
  const tabs = [
    { value: 'mapa', label: 'Mapa' },
    { value: 'localidades', label: 'Localidades e bairros' },
    ...(podeEditar ? [{ value: 'importar', label: 'Importar malha' }] : []),
    { value: 'pendencias', label: 'Pendências dos imóveis' },
    { value: 'configuracao', label: 'Configuração' },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Território" description="Localidade, bairro, quarteirão e imóvel únicos para ACS, ACE e vigilância. A posição do imóvel liga-o ao quarteirão; o raio do bloqueio parte dela." />
      {!r ? (
        <Spinner />
      ) : (
        <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6" id="terr-resumo">
          <Stat label="Localidades" value={r.localidades} hint={`${r.bairros} bairro(s)`} />
          <Stat label="Quarteirões" value={r.quarteiroes.toLocaleString('pt-BR')} hint={r.config.numeracaoQuarteirao === 'BAIRRO' ? 'Numeração por bairro' : 'Numeração por localidade'} />
          <Stat label="Imóveis" value={r.imoveis.toLocaleString('pt-BR')} />
          <Stat label="Sem posição" value={r.semPosicao.toLocaleString('pt-BR')} tone={r.semPosicao ? 'warn' : 'good'} />
          <Stat label="Fora de quarteirão" value={r.semQuarteirao.toLocaleString('pt-BR')} tone={r.semQuarteirao ? 'warn' : 'good'} hint="Com posição" />
          <Stat
            label="Posição que serve ao bloqueio"
            value={r.imoveis ? `${Math.round((100 * bons) / r.imoveis)}%` : '—'}
            hint={r.baseDeEnderecos ? `Base do IBGE: ${r.baseDeEnderecos.toLocaleString('pt-BR')} endereços` : 'Sem a base de endereços do IBGE'}
            tone={r.imoveis && bons / r.imoveis >= 0.8 ? 'good' : 'warn'}
          />
        </div>
      )}
      {r?.ultimaImportacao && (
        <p className="text-xs text-slate-500">
          Última importação: {r.ultimaImportacao.fileName} em {fmtDateTime(r.ultimaImportacao.appliedAt)}.
        </p>
      )}
      <Tabs
        value={tab}
        onValueChange={(v) => {
          setTab(v);
          // Marcação pedida nas pendências vale só para esta ida ao mapa.
          if (v !== 'mapa') setAPosicionar(null);
        }}
        tabs={tabs}
      >
        <TabPanel value="mapa">
          {/* O mapa só monta na aba visível (o Leaflet mede o contêiner ao criar). */}
          {tab === 'mapa' && r && (
            <AbaMapa
              podeEditar={podeEditar}
              podePosicionar={podePosicionar}
              raioPadrao={r.config.raioBloqueioM}
              imovelAPosicionar={aPosicionar}
              onPosicionado={() => (setAPosicionar(null), atualizar())}
              onCancelarPosicao={() => setAPosicionar(null)}
              onAlterado={atualizar}
            />
          )}
        </TabPanel>
        <TabPanel value="localidades">
          <AbaLocalidades podeEditar={podeEditar} onAlterado={atualizar} />
        </TabPanel>
        {podeEditar && (
          <TabPanel value="importar">
            <AbaImportar srcAceitos={config.data?.srcAceitos ?? []} onAplicada={atualizar} />
          </TabPanel>
        )}
        <TabPanel value="pendencias">
          <AbaPendencias
            podeEditar={podeEditar}
            podePosicionar={podePosicionar}
            versao={versao}
            onAlterado={atualizar}
            onMarcar={(h) => {
              setAPosicionar(h);
              setTab('mapa');
            }}
          />
        </TabPanel>
        <TabPanel value="configuracao">{r && <AbaConfiguracao key={`${r.config.numeracaoQuarteirao}|${r.config.raioBloqueioM}`} resumo={r} podeEditar={podeEditar} onSalvo={atualizar} />}</TabPanel>
      </Tabs>
    </div>
  );
}
