'use client';

import { CloudDownload, FileUp, Link2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, ApiError, errorMessage } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { LocationSelect } from './location-select';
import type { Product } from './types';

interface Unmapped {
  item: number;
  supplierCode: string;
  gtin: string | null;
  description: string;
  suggestions: { productId: string; description: string }[];
}

interface ImportResult {
  invoiceId: string;
  accessKey: string;
  supplier: string;
  total: number;
  entries: { productId: string; lot: string; expiry: string; quantity: number }[];
}

interface Invoice {
  id: string;
  accessKey: string;
  number: string;
  series: string;
  supplierName: string;
  supplierCnpj: string;
  issuedAt: string;
  totalValue: number;
  source: string;
  importedAt: string;
  items: { id: string; description: string; quantity: number; lots: { lot: string; expiry: string; quantity: number }[] }[];
}

interface SefazDoc {
  accessKey: string;
  supplier: { cnpj: string; nome: string } | string;
  issuedAt: string;
  total: number;
  imported: boolean;
}

type Problem = { kind: 'unmapped'; supplierCnpj: string; items: Unmapped[] } | { kind: 'rastro'; problems: { item: number; description: string; problem: string }[] } | { kind: 'other'; message: string };

export function NfeTab() {
  const session = useSession();
  const toast = useToast();
  const canImport = session.can('nfe.importar');
  const [locationId, setLocationId] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [lastXml, setLastXml] = useState<string | null>(null);
  const [lastKey, setLastKey] = useState<string | null>(null);
  const [mapping, setMapping] = useState<{ supplierCnpj: string; item: Unmapped } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const invoices = useApi<Invoice[]>('/pharmacy/nfe');
  const [sefaz, setSefaz] = useState<SefazDoc[] | null>(null);
  const [sefazError, setSefazError] = useState<string | null>(null);

  function handleError(err: unknown) {
    if (err instanceof ApiError && err.code === 'NFE_SEM_DE_PARA') {
      const d = err.details as { supplierCnpj: string; unmapped: Unmapped[] };
      setProblem({ kind: 'unmapped', supplierCnpj: d.supplierCnpj, items: d.unmapped });
    } else if (err instanceof ApiError && err.code === 'NFE_RASTREABILIDADE') {
      setProblem({ kind: 'rastro', problems: (err.details as { problems: { item: number; description: string; problem: string }[] }).problems });
    } else setProblem({ kind: 'other', message: errorMessage(err) });
  }

  async function importXml(xml: string) {
    setPending(true);
    setProblem(null);
    setResult(null);
    setLastXml(xml);
    setLastKey(null);
    try {
      const res = await api.post<ImportResult>('/pharmacy/nfe/import', { xml, locationId });
      setResult(res);
      toast.success(`NF-e importada: ${res.entries.length} lote(s) creditados no estoque.`);
      void invoices.reload();
    } catch (err) {
      handleError(err);
    } finally {
      setPending(false);
    }
  }

  async function importSefaz(accessKey: string) {
    setPending(true);
    setProblem(null);
    setResult(null);
    setLastXml(null);
    setLastKey(accessKey);
    try {
      const res = await api.post<ImportResult>(`/pharmacy/nfe/sefaz/${accessKey}/import`, { locationId });
      setResult(res);
      toast.success('NF-e importada da SEFAZ.');
      void invoices.reload();
      setSefaz((s) => s?.map((d) => (d.accessKey === accessKey ? { ...d, imported: true } : d)) ?? null);
    } catch (err) {
      handleError(err);
    } finally {
      setPending(false);
    }
  }

  async function loadSefaz() {
    setSefazError(null);
    try {
      setSefaz(await api.get<SefazDoc[]>('/pharmacy/nfe/sefaz'));
    } catch (err) {
      setSefazError(errorMessage(err));
    }
  }

  const retry = () => (lastXml ? importXml(lastXml) : lastKey ? importSefaz(lastKey) : undefined);

  return (
    <div className="space-y-4">
      {canImport && (
        <Card>
          <CardHeader title="Entrada de nota fiscal (NF-e)" description="O bloco de rastreabilidade (lote, fabricação e validade) é obrigatório para medicamentos." />
          <CardBody className="space-y-4">
            <div className="grid gap-3 md:grid-cols-[minmax(0,18rem)_1fr]">
              <Field label="Local de entrada">
                <LocationSelect value={locationId} onChange={setLocationId} />
              </Field>
              <div className="flex flex-wrap items-end gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept=".xml,application/xml,text/xml"
                  className="hidden"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) await importXml(await f.text());
                  }}
                />
                <Button onClick={() => fileRef.current?.click()} loading={pending} disabled={!locationId}>
                  <FileUp className="h-4 w-4" /> Enviar XML da NF-e
                </Button>
                <Button variant="secondary" onClick={loadSefaz} disabled={!locationId}>
                  <CloudDownload className="h-4 w-4" /> Buscar notas na SEFAZ
                </Button>
              </div>
            </div>
            {sefazError && <Alert tone="warn" title="SEFAZ indisponível">{sefazError} Use o envio do XML (contingência).</Alert>}
            {sefaz && (
              <Table>
                <THead>
                  <tr>
                    <TH>Chave de acesso</TH>
                    <TH>Emitente</TH>
                    <TH>Emissão</TH>
                    <TH className="text-right">Valor</TH>
                    <TH />
                  </tr>
                </THead>
                <TBody>
                  {sefaz.map((d) => (
                    <TR key={d.accessKey}>
                      <TD className="font-mono text-xs">{d.accessKey}</TD>
                      <TD>{typeof d.supplier === 'string' ? d.supplier : d.supplier.nome}</TD>
                      <TD>{fmtDate(d.issuedAt)}</TD>
                      <TD className="text-right">{fmtMoney(d.total)}</TD>
                      <TD className="text-right">
                        {d.imported ? (
                          <Badge tone="green">Importada</Badge>
                        ) : (
                          <Button size="sm" onClick={() => importSefaz(d.accessKey)} loading={pending && lastKey === d.accessKey} disabled={pending}>
                            Importar
                          </Button>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
            {problem?.kind === 'other' && <Alert tone="error">{problem.message}</Alert>}
            {problem?.kind === 'rastro' && (
              <Alert tone="error" title="Rastreabilidade incompleta: a nota não foi importada">
                <ul className="list-disc pl-5">
                  {problem.problems.map((p, i) => (
                    <li key={i}>
                      Item {p.item} ({p.description}): {p.problem}
                    </li>
                  ))}
                </ul>
              </Alert>
            )}
            {problem?.kind === 'unmapped' && (
              <Alert tone="warn" title="Itens sem correspondência no catálogo (De-Para)">
                <p className="mb-2">Vincule cada item do fornecedor a um produto do catálogo e importe de novo.</p>
                <ul className="space-y-2">
                  {problem.items.map((u) => (
                    <li key={u.item} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-white/70 p-2">
                      <span>
                        <strong>Item {u.item}:</strong> {u.description}
                        <span className="block text-xs">
                          Código {u.supplierCode}
                          {u.gtin ? ` · GTIN ${u.gtin}` : ''}
                        </span>
                      </span>
                      <Button size="sm" variant="secondary" onClick={() => setMapping({ supplierCnpj: problem.supplierCnpj, item: u })}>
                        <Link2 className="h-4 w-4" /> Vincular
                      </Button>
                    </li>
                  ))}
                </ul>
                <Button size="sm" className="mt-3" onClick={retry} loading={pending}>
                  Importar novamente
                </Button>
              </Alert>
            )}
            {result && (
              <Alert tone="success" title={`NF-e de ${result.supplier} importada (${fmtMoney(result.total)})`}>
                <ul className="list-disc pl-5">
                  {result.entries.map((e, i) => (
                    <li key={i}>
                      Lote {e.lot} · validade {fmtDate(e.expiry)} · {e.quantity.toLocaleString('pt-BR')} unidades
                    </li>
                  ))}
                </ul>
              </Alert>
            )}
          </CardBody>
        </Card>
      )}
      <Card>
        <CardHeader title="Notas importadas" />
        {invoices.loading ? (
          <Spinner />
        ) : (invoices.data ?? []).length === 0 ? (
          <EmptyState title="Nenhuma nota importada" />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Nota</TH>
                <TH>Fornecedor</TH>
                <TH>Emissão</TH>
                <TH>Itens</TH>
                <TH className="text-right">Valor</TH>
                <TH>Origem</TH>
                <TH>Importada em</TH>
              </tr>
            </THead>
            <TBody>
              {(invoices.data ?? []).map((n) => (
                <TR key={n.id}>
                  <TD>
                    {n.number}/{n.series}
                    <span className="block font-mono text-[11px] text-slate-500">{n.accessKey}</span>
                  </TD>
                  <TD>{n.supplierName}</TD>
                  <TD>{fmtDate(n.issuedAt)}</TD>
                  <TD>{n.items.length}</TD>
                  <TD className="text-right">{fmtMoney(n.totalValue)}</TD>
                  <TD>
                    <Badge tone={n.source === 'SEFAZ' ? 'blue' : 'slate'}>{n.source}</Badge>
                  </TD>
                  <TD>{fmtDateTime(n.importedAt)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      {mapping && (
        <MappingDialog
          supplierCnpj={mapping.supplierCnpj}
          item={mapping.item}
          onClose={() => setMapping(null)}
          onSaved={() => {
            toast.success('De-Para salvo.');
            setProblem((p) => (p?.kind === 'unmapped' ? { ...p, items: p.items.filter((i) => i.item !== mapping.item.item) } : p));
            setMapping(null);
          }}
        />
      )}
    </div>
  );
}

function MappingDialog({ supplierCnpj, item, onClose, onSaved }: { supplierCnpj: string; item: Unmapped; onClose: () => void; onSaved: () => void }) {
  const [productId, setProductId] = useState(item.suggestions[0]?.productId ?? '');
  const [factor, setFactor] = useState('1');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Product[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Vincular item do fornecedor (De-Para)"
      description={item.description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={pending}
            disabled={!productId}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                await api.post('/pharmacy/mappings', {
                  productId,
                  supplierCnpj,
                  supplierCode: item.supplierCode,
                  ...(item.gtin ? { gtin: item.gtin.replace(/\D/g, '') } : {}),
                  conversionFactor: Number(factor.replace(',', '.')) || 1,
                });
                onSaved();
              } catch (err) {
                setError(errorMessage(err));
              } finally {
                setPending(false);
              }
            }}
          >
            Salvar vínculo
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {item.suggestions.length > 0 && (
          <Field label="Sugestões pelo princípio ativo">
            <Select value={productId} onChange={(e) => setProductId(e.target.value)}>
              <option value="">Selecione…</option>
              {item.suggestions.map((s) => (
                <option key={s.productId} value={s.productId}>
                  {s.description}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Ou busque no catálogo">
          <div className="flex gap-2">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Descrição, princípio ativo ou código" />
            <Button
              variant="secondary"
              onClick={async () => {
                try {
                  setResults(await api.get<Product[]>(`/pharmacy/products?q=${encodeURIComponent(q)}`));
                } catch (err) {
                  setError(errorMessage(err));
                }
              }}
            >
              Buscar
            </Button>
          </div>
        </Field>
        {results.length > 0 && (
          <Select value={productId} onChange={(e) => setProductId(e.target.value)} aria-label="Produto do catálogo">
            <option value="">Selecione…</option>
            {results.map((p) => (
              <option key={p.id} value={p.id}>
                {p.description} ({p.code})
              </option>
            ))}
          </Select>
        )}
        <Field label="Fator de conversão" hint="Quantas unidades de estoque há em cada unidade da nota (ex.: caixa com 20 comprimidos = 20).">
          <Input value={factor} onChange={(e) => setFactor(e.target.value)} inputMode="decimal" />
        </Field>
        {error && <Alert tone="error">{error}</Alert>}
      </div>
    </Dialog>
  );
}
