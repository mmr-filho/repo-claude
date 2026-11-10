'use client';

import { ROTULO_NIVEL_TERRITORIO, type RespostaSugestoesSurto, type SugestaoSurtoTela } from '@omnisaude/shared';
import { BellPlus, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { nomeDoAgravo, type OpcaoAgravo } from './diagrama-agravos';
import { dataBr, faltaNoMotivo, MINIMO_MOTIVO, numeroBr, ROTULO_VINCULO } from './surto-regras';

/** Dispensa a sugestão: volta só se aparecer caso conhecido depois do último caso dela. */
function Dispensar({ s, onFechar, onFeito }: { s: SugestaoSurtoTela; onFechar: () => void; onFeito: () => void }) {
  const toast = useToast();
  const [motivo, setMotivo] = useState('');
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const falta = faltaNoMotivo(motivo);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onFechar()}
      title="Dispensar a sugestão"
      description="A sugestão some até aparecer um caso novo do mesmo agravo e vínculo, conhecido depois do último desta sugestão. O motivo fica registrado."
      footer={
        <Button
          variant="secondary"
          disabled={falta > 0}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setErro(null);
            try {
              await api.post('/vigilancia/surtos/sugestoes/dispensar', { assinatura: s.assinatura, motivo: motivo.trim() });
              toast.success('Sugestão dispensada.');
              onFeito();
            } catch (err) {
              setErro(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <EyeOff className="h-4 w-4" /> Dispensar
        </Button>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-slate-700">
          {s.descricao} · {ROTULO_VINCULO[s.vinculo.tipo]}: {s.vinculoNome} · {s.casos.length} caso(s)
        </p>
        <Field label="Motivo" htmlFor="ss-dispensar-motivo" hint={falta ? `Pelo menos ${MINIMO_MOTIVO} caracteres (faltam ${falta}).` : undefined}>
          <Textarea
            id="ss-dispensar-motivo"
            rows={3}
            maxLength={1000}
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder="Ex.: casos sem vínculo entre si na investigação; mesma família já acompanhada."
          />
        </Field>
        {erro && <Alert tone="error">{erro}</Alert>}
      </div>
    </Dialog>
  );
}

function CartaoSugestao({ s, opcoes, onAbrir, onDispensar }: { s: SugestaoSurtoTela; opcoes: OpcaoAgravo[]; onAbrir: () => void; onDispensar: () => void }) {
  return (
    <Card>
      <CardHeader
        title={`${nomeDoAgravo(opcoes, s.grupo)} · ${ROTULO_VINCULO[s.vinculo.tipo]}: ${s.vinculoNome}`}
        description={s.descricao}
        actions={
          <>
            <Button size="sm" onClick={onAbrir}>
              <BellPlus className="h-4 w-4" /> Notificar surto
            </Button>
            <Button size="sm" variant="secondary" onClick={onDispensar}>
              <EyeOff className="h-4 w-4" /> Dispensar
            </Button>
          </>
        }
      />
      <CardBody className="space-y-3 pt-3">
        <p className="flex flex-wrap gap-2 text-xs">
          <Badge tone="amber">{s.casos.length} caso(s)</Badge>
          {s.primeiroSintoma && <Badge tone="slate">1º sintoma em {dataBr(s.primeiroSintoma)}</Badge>}
          <Badge tone="slate">Último caso conhecido em {fmtDateTime(s.ultimoConhecimento)}</Badge>
        </p>
        <Table>
          <THead>
            <tr>
              <TH>Notificação</TH>
              <TH>Agravo</TH>
              <TH>Unidade</TH>
              <TH>Bairro</TH>
              <TH>Início dos sintomas</TH>
              <TH>Conhecida em</TH>
            </tr>
          </THead>
          <TBody>
            {s.casosDetalhe.map((c) => (
              <TR key={c.id}>
                <TD className="whitespace-nowrap font-medium tabular-nums">{c.numero}</TD>
                <TD>{c.agravo}</TD>
                <TD>{c.unidade || '—'}</TD>
                <TD>{c.bairro ?? '—'}</TD>
                <TD className="tabular-nums">{dataBr(c.inicioSintomas)}</TD>
                <TD className="whitespace-nowrap tabular-nums">{fmtDateTime(c.conhecidoEm)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
        <p className="text-[11px] text-slate-500">Base: {s.fonte}</p>
      </CardBody>
    </Card>
  );
}

/**
 * Sugestões de surto (o sistema sugere, a vigilância confirma): aglomerados de notificações por quarteirão, bairro ou
 * unidade, evento inusitado e, para dengue, chikungunya e Zika, os territórios acima do limite superior do canal.
 */
export function SurtoSugestoes({ opcoes, onAbrir }: { opcoes: OpcaoAgravo[]; onAbrir: (s: SugestaoSurtoTela) => void }) {
  const r = useApi<RespostaSugestoesSurto>('/vigilancia/surtos/sugestoes');
  const [dispensar, setDispensar] = useState<SugestaoSurtoTela | null>(null);
  return (
    <div className="space-y-4">
      {r.error && <Alert tone="error">{r.error}</Alert>}
      {r.loading && !r.data && <Spinner label="Procurando aglomerados…" />}
      {r.data && (
        <>
          {r.data.avisos.length > 0 && (
            <Alert tone="warn" title="Avisos">
              <ul className="list-inside list-disc space-y-0.5">
                {r.data.avisos.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </Alert>
          )}
          {r.data.sugestoes.length === 0 ? (
            <Card>
              <EmptyState
                title="Nenhuma sugestão de surto agora"
                description="O sistema olha as notificações dos últimos 30 dias: 2 ou mais casos do mesmo agravo no mesmo quarteirão ou bairro em 7 dias, varicela em hospital, síndrome gripal na mesma unidade e o agravo ausente há muito tempo."
              />
            </Card>
          ) : (
            r.data.sugestoes.map((s) => <CartaoSugestao key={s.assinatura} s={s} opcoes={opcoes} onAbrir={() => onAbrir(s)} onDispensar={() => setDispensar(s)} />)
          )}
          <Card>
            <CardHeader
              title="Dengue, chikungunya e Zika acima do limite superior"
              description="Na última semana completa, pelo canal do território (bairro ou localidade). O estágio do plano fica na aba Contingência; o canal, na aba Diagrama de controle."
            />
            {r.data.excessos.length === 0 ? (
              <CardBody className="pt-3 text-sm text-slate-600">Nenhum território acima do limite superior.</CardBody>
            ) : (
              <Table>
                <THead>
                  <tr>
                    <TH>Agravo</TH>
                    <TH>Território</TH>
                    <TH>Semana</TH>
                    <TH className="text-right">Casos</TH>
                    <TH className="text-right">Valor na semana</TH>
                    <TH className="text-right">Limite superior</TH>
                  </tr>
                </THead>
                <TBody>
                  {r.data.excessos.map((x) => (
                    <TR key={`${x.grupo}-${x.nivel}-${x.territorioId ?? 'municipio'}-${x.semana}`}>
                      <TD>{nomeDoAgravo(opcoes, x.grupo)}</TD>
                      <TD>
                        {x.territorioNome}
                        <span className="block text-xs text-slate-500">{ROTULO_NIVEL_TERRITORIO[x.nivel]}</span>
                      </TD>
                      <TD className="tabular-nums">
                        SE {x.semana.slice(4)}/{x.semana.slice(0, 4)}
                      </TD>
                      <TD className="text-right tabular-nums">{x.casos.toLocaleString('pt-BR')}</TD>
                      <TD className="text-right font-medium tabular-nums text-red-700">{numeroBr(x.valor)}</TD>
                      <TD className="text-right tabular-nums">{numeroBr(x.ls)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        </>
      )}
      {dispensar && (
        <Dispensar
          s={dispensar}
          onFechar={() => setDispensar(null)}
          onFeito={() => {
            setDispensar(null);
            void r.reload();
          }}
        />
      )}
    </div>
  );
}
