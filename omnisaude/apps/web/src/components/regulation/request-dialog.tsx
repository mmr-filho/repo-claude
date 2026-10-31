'use client';

import { PRIORIDADES, prioridadeSugerida, type PrioridadeRegulacao, type TipoSolicitacao } from '@omnisaude/shared';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { PRIORIDADE_TONE, type Protocolos, type Solicitacao } from './types';

interface Verificacao {
  examesFaltantes: { nome: string }[];
  examesRecomendados: { nome: string }[];
  pendencias: string[];
}

/** Nova solicitação de consulta especializada, exame ou procedimento, guiada pelo protocolo de encaminhamento. */
export function RequestDialog({
  aberto,
  onClose,
  patientId,
  encounterId,
  cidInicial,
  resumoInicial,
  onCriada,
}: {
  aberto: boolean;
  onClose: () => void;
  patientId: string;
  encounterId?: string | null;
  cidInicial?: string | null;
  resumoInicial?: string | null;
  onCriada: (s: Solicitacao) => void;
}) {
  const protocolos = useApi<Protocolos>(aberto ? '/regulacao/protocolos' : null, [aberto]);
  const documentos = useApi<{ id: string; kind: string; mimeType: string; createdAt: string }[]>(aberto ? `/patients/${patientId}/documents` : null, [aberto, patientId]);
  const [kind, setKind] = useState<TipoSolicitacao>('CONSULTA');
  const [specialty, setSpecialty] = useState('');
  const [criterios, setCriterios] = useState<string[]>([]);
  const [priority, setPriority] = useState<PrioridadeRegulacao>('AZUL');
  const [prioridadeManual, setPrioridadeManual] = useState(false);
  const [justificativa, setJustificativa] = useState('');
  const [resumo, setResumo] = useState('');
  const [cid, setCid] = useState('');
  const [anexos, setAnexos] = useState<string[]>([]);
  const [verificacao, setVerificacao] = useState<Verificacao | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!aberto) return;
    setKind('CONSULTA');
    setSpecialty('');
    setCriterios([]);
    setPriority('AZUL');
    setPrioridadeManual(false);
    setJustificativa('');
    setResumo(resumoInicial ?? '');
    setCid(cidInicial ?? '');
    setAnexos([]);
    setVerificacao(null);
    setErro(null);
  }, [aberto, cidInicial, resumoInicial]);

  const opcoes = useMemo(() => {
    if (!protocolos.data) return [];
    return kind === 'CONSULTA'
      ? protocolos.data.especialidades.map((e) => ({ codigo: e.codigo, nome: e.nome }))
      : protocolos.data.procedimentos.filter((p) => p.tipo === kind).map((p) => ({ codigo: p.codigo, nome: p.nome }));
  }, [protocolos.data, kind]);
  const def = useMemo(
    () => (kind === 'CONSULTA' ? protocolos.data?.especialidades.find((e) => e.codigo === specialty) : protocolos.data?.procedimentos.find((p) => p.codigo === specialty)) ?? null,
    [protocolos.data, kind, specialty],
  );
  const criteriosDef = def?.criterios ?? [];
  const sugerida = prioridadeSugerida(criteriosDef, criterios);

  useEffect(() => {
    if (!prioridadeManual) setPriority(sugerida);
  }, [sugerida, prioridadeManual]);
  useEffect(() => {
    setCriterios([]);
    setPrioridadeManual(false);
    setVerificacao(null);
  }, [specialty, kind]);
  useEffect(() => {
    if (!specialty || !aberto) return;
    const ctrl = { cancelado: false };
    api
      .post<Verificacao>('/regulacao/verificar', { patientId, kind, specialty, criteria: criterios, priority, priorityJustification: justificativa || null })
      .then((v) => !ctrl.cancelado && setVerificacao(v))
      .catch(() => !ctrl.cancelado && setVerificacao(null));
    return () => {
      ctrl.cancelado = true;
    };
  }, [specialty, kind, criterios, priority, justificativa, patientId, aberto]);

  const toggle = (c: string) => setCriterios((x) => (x.includes(c) ? x.filter((y) => y !== c) : [...x, c]));
  const exige = PRIORIDADES[priority].exigeJustificativa;

  async function enviar() {
    setErro(null);
    if (!specialty) return setErro('Escolha a especialidade, o exame ou o procedimento');
    if (resumo.trim().length < 10) return setErro('Descreva o quadro clínico e o motivo do encaminhamento');
    if (exige && !justificativa.trim()) return setErro(`Prioridade ${PRIORIDADES[priority].label.toLowerCase()} exige justificativa clínica`);
    setBusy(true);
    try {
      const s = await api.post<Solicitacao>('/regulacao/solicitacoes', {
        patientId,
        encounterId: encounterId ?? null,
        kind,
        specialty,
        priority,
        priorityJustification: justificativa.trim() || null,
        clinicalSummary: resumo.trim(),
        criteria: criterios,
        cid: cid.trim() || null,
        attachmentIds: anexos,
      });
      onCriada(s);
      onClose();
    } catch (err) {
      setErro(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={aberto}
      onOpenChange={(o) => !o && onClose()}
      title="Nova solicitação à regulação"
      description="Consulta especializada, exame ou procedimento na fila única, conforme o protocolo de encaminhamento"
      size="xl"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={enviar} loading={busy} id="reg-enviar">
            Enviar à regulação
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {erro && <Alert tone="error">{erro}</Alert>}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Tipo" htmlFor="reg-tipo">
            <Select
              id="reg-tipo"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as TipoSolicitacao);
                setSpecialty('');
              }}
            >
              <option value="CONSULTA">Consulta especializada</option>
              <option value="EXAME">Exame</option>
              <option value="PROCEDIMENTO">Procedimento</option>
            </Select>
          </Field>
          <Field label={kind === 'CONSULTA' ? 'Especialidade' : kind === 'EXAME' ? 'Exame' : 'Procedimento'} htmlFor="reg-esp" className="sm:col-span-2">
            <Select id="reg-esp" value={specialty} onChange={(e) => setSpecialty(e.target.value)}>
              <option value="">Escolha…</option>
              {opcoes.map((o) => (
                <option key={o.codigo} value={o.codigo}>
                  {o.nome}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {def && (
          <section className="rounded-lg border border-slate-200 p-3">
            <p className="mb-2 text-sm font-semibold">Critérios de encaminhamento do protocolo</p>
            <div className="flex flex-col gap-1">
              {criteriosDef.map((c) => (
                <label key={c.codigo} className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={criterios.includes(c.codigo)} onChange={() => toggle(c.codigo)} />
                  <span>
                    {c.descricao} <Badge tone={PRIORIDADE_TONE[c.prioridade]}>{PRIORIDADES[c.prioridade].label}</Badge>
                  </span>
                </label>
              ))}
            </div>
            {'manejoNaAps' in def && def.manejoNaAps.length > 0 && (
              <p className="mt-2 text-xs text-slate-500">
                Segue na atenção primária: {def.manejoNaAps.join('; ')}. <span className="italic">{def.fonte}</span>
              </p>
            )}
            {'examesMinimos' in def && def.examesMinimos.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1 text-xs">
                <span className="text-slate-500">Exames mínimos:</span>
                {def.examesMinimos.map((e) => {
                  const falta = verificacao?.examesFaltantes.some((x) => x.nome === e.nome);
                  const recomendado = verificacao?.examesRecomendados.some((x) => x.nome === e.nome);
                  return (
                    <Badge key={e.sigtapCode} tone={falta ? 'red' : recomendado ? 'amber' : 'green'}>
                      {e.nome}
                      {e.obrigatorio ? '' : ' (opcional)'}
                      {falta ? ' · sem resultado' : recomendado ? ' · sem resultado' : ' · no prontuário'}
                    </Badge>
                  );
                })}
              </div>
            )}
          </section>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Prioridade" htmlFor="reg-prio" hint={`Sugerida pelos critérios: ${PRIORIDADES[sugerida].label}`}>
            <Select
              id="reg-prio"
              value={priority}
              onChange={(e) => {
                setPriority(e.target.value as PrioridadeRegulacao);
                setPrioridadeManual(true);
              }}
            >
              {(Object.keys(PRIORIDADES) as PrioridadeRegulacao[]).map((p) => (
                <option key={p} value={p}>
                  {PRIORIDADES[p].label} · até {PRIORIDADES[p].prazoDias} dia(s)
                </option>
              ))}
            </Select>
          </Field>
          <Field label="CID-10" htmlFor="reg-cid">
            <Input id="reg-cid" value={cid} onChange={(e) => setCid(e.target.value)} placeholder="I10" />
          </Field>
          <Field label="Anexos (documentos do paciente)" htmlFor="reg-anexos">
            <Select id="reg-anexos" multiple value={anexos} onChange={(e) => setAnexos([...e.target.selectedOptions].map((o) => o.value))} className="h-20">
              {(documentos.data ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.kind} · {new Date(d.createdAt).toLocaleDateString('pt-BR')}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {exige && (
          <Field label="Justificativa da prioridade" htmlFor="reg-just" hint="Obrigatória para emergência e urgência">
            <Textarea id="reg-just" rows={2} value={justificativa} onChange={(e) => setJustificativa(e.target.value)} />
          </Field>
        )}
        <Field label="Quadro clínico e motivo do encaminhamento" htmlFor="reg-resumo">
          <Textarea id="reg-resumo" rows={4} value={resumo} onChange={(e) => setResumo(e.target.value)} placeholder="História, exame físico, tratamentos já feitos e resultados relevantes" />
        </Field>
        {verificacao && verificacao.pendencias.length > 0 && (
          <Alert tone="warn" title="Pendências do protocolo (o regulador vê isto)">
            <ul className="list-inside list-disc">
              {verificacao.pendencias.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Alert>
        )}
      </div>
    </Dialog>
  );
}
