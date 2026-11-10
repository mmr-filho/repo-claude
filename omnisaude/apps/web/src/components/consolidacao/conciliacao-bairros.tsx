'use client';

import type { ListaBairrosSemCorrespondencia, RespostaApelidoBairro, BairroSemCorrespondencia } from '@omnisaude/shared';
import { Tag } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { useTerritorios } from './diagrama-seletores';

/** Escolher o bairro do território que recebe o nome como apelido (os parecidos primeiro). */
function DialogoApelido({ bairro, onFechar, onFeito }: { bairro: BairroSemCorrespondencia; onFechar: () => void; onFeito: () => void }) {
  const toast = useToast();
  const territorio = useTerritorios('BAIRRO');
  const [escolhido, setEscolhido] = useState(bairro.candidatos[0]?.neighborhoodId ?? '');
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const parecidos = new Set(bairro.candidatos.map((c) => c.neighborhoodId));
  const nomeLocalidade = new Map(territorio.localidades.map((l) => [l.id, l.name]));
  const outros = territorio.bairros.filter((b) => !parecidos.has(b.id));
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onFechar()}
      title={`Adicionar o apelido "${bairro.nome}"`}
      description="O nome que veio nos registros oficiais passa a valer como apelido do bairro escolhido: os casos entram no bairro (diagrama e sugestões de surto). Fica na auditoria do território."
      footer={
        <Button
          loading={busy}
          disabled={!escolhido}
          onClick={async () => {
            setBusy(true);
            setErro(null);
            try {
              const r = await api.post<RespostaApelidoBairro>('/vigilancia/conciliacao/bairros/apelido', { nome: bairro.nome, neighborhoodId: escolhido });
              toast.success(`Apelido gravado: ${r.registros.toLocaleString('pt-BR')} registro(s) passam a cair no bairro.`);
              onFeito();
            } catch (err) {
              setErro(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Tag className="h-4 w-4" /> Adicionar o apelido
        </Button>
      }
    >
      <div className="space-y-3">
        <Field label="Bairro do território" htmlFor="conc-apelido-bairro">
          <Select id="conc-apelido-bairro" value={escolhido} onChange={(e) => setEscolhido(e.target.value)}>
            <option value="">Escolha o bairro</option>
            {bairro.candidatos.length > 0 && (
              <optgroup label="Parecidos">
                {bairro.candidatos.map((c) => (
                  <option key={c.neighborhoodId} value={c.neighborhoodId}>
                    {c.nome}
                    {c.localidade ? ` (${c.localidade})` : ''}
                  </option>
                ))}
              </optgroup>
            )}
            {outros.length > 0 && (
              <optgroup label="Todos os bairros">
                {outros.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                    {nomeLocalidade.get(b.localityId) ? ` (${nomeLocalidade.get(b.localityId)})` : ''}
                  </option>
                ))}
              </optgroup>
            )}
          </Select>
        </Field>
        {territorio.carregando && <p className="text-xs text-slate-500">Carregando os bairros do território…</p>}
        {erro && <Alert tone="error">{erro}</Alert>}
      </div>
    </Dialog>
  );
}

/**
 * Nomes de bairro dos registros oficiais sem correspondência no território (residência no município). Adicionar apelido
 * exige também `territorio.editar`.
 */
export function ListaBairrosConciliacao({ podeEditarTerritorio, onMudou }: { podeEditarTerritorio: boolean; onMudou: () => void }) {
  const lista = useApi<ListaBairrosSemCorrespondencia>('/vigilancia/conciliacao/bairros');
  const [apelido, setApelido] = useState<BairroSemCorrespondencia | null>(null);
  if (lista.loading && !lista.data) return <Spinner />;
  if (lista.error) return <Alert tone="error">{lista.error}</Alert>;
  if (!lista.data?.length) return <EmptyState title="Todos os nomes de bairro têm correspondência no território" />;
  return (
    <>
      {!podeEditarTerritorio && <p className="px-4 pt-3 text-xs text-slate-500">Adicionar apelido a um bairro exige a permissão de editar o território.</p>}
      <Table>
        <THead>
          <tr>
            <TH>Nome nos registros</TH>
            <TH>Código</TH>
            <TH className="text-right">Registros</TH>
            <TH>Bairros parecidos</TH>
            {podeEditarTerritorio && <TH className="w-40" />}
          </tr>
        </THead>
        <TBody>
          {lista.data.map((b) => (
            <TR key={b.nomeNormalizado}>
              <TD className="text-sm font-medium">{b.nome}</TD>
              <TD className="tabular-nums text-sm">{b.codigo ?? '—'}</TD>
              <TD className="text-right tabular-nums">{b.registros.toLocaleString('pt-BR')}</TD>
              <TD className="text-sm text-slate-600">{b.candidatos.length ? b.candidatos.map((c) => c.nome).join(', ') : '—'}</TD>
              {podeEditarTerritorio && (
                <TD className="text-right">
                  <Button size="sm" variant="secondary" onClick={() => setApelido(b)}>
                    <Tag className="h-4 w-4" /> Adicionar apelido…
                  </Button>
                </TD>
              )}
            </TR>
          ))}
        </TBody>
      </Table>
      {apelido && (
        <DialogoApelido
          bairro={apelido}
          onFechar={() => setApelido(null)}
          onFeito={() => {
            setApelido(null);
            void lista.reload();
            onMudou();
          }}
        />
      )}
    </>
  );
}
