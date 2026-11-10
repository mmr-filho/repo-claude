'use client';

import type { RespostaAcionar, SituacaoContingencia } from '@omnisaude/shared';
import { Siren } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { errosAcionamento, estagiosOrdenados, justificativaSugerida, MINIMO_JUSTIFICATIVA, type TerritorioDaContingencia } from './contingencia-regras';

/**
 * Acionamento de estágio: fecha o acionamento em vigor do território (fim na véspera), abre o novo com o retrato dos
 * indicadores e cria o checklist com as ações do estágio e dos anteriores. A decisão é da vigilância (Plano 2025,
 * item 7.1); a justificativa tem pelo menos 20 caracteres e o ato (decreto, portaria) é opcional.
 */
export function ContingenciaAcionar({ s, territorio, onFechar, onAcionado }: { s: SituacaoContingencia; territorio: TerritorioDaContingencia; onFechar: () => void; onAcionado: () => void }) {
  const toast = useToast();
  const definicao = s.plano!.definicao;
  const sugerido = s.avaliacao?.sugerido ?? '';
  const [estagio, setEstagio] = useState(sugerido && sugerido !== s.estagioAtual.chave ? sugerido : '');
  const [justificativa, setJustificativa] = useState('');
  const [ato, setAto] = useState('');
  const [tocado, setTocado] = useState(false);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const erros = errosAcionamento({ estagio, justificativa, ato });
  const proposta = justificativaSugerida(definicao, s.avaliacao, estagio, s.semanaReferencia);
  const mesmo = estagio && estagio === s.estagioAtual.chave && s.estagioAtual.acionamentoId;
  const falta = Math.max(0, MINIMO_JUSTIFICATIVA - justificativa.trim().length);

  async function acionar() {
    setTocado(true);
    if (erros.length) return;
    setBusy(true);
    setErro(null);
    try {
      const r = await api.post<RespostaAcionar>('/vigilancia/contingencia/acionar', {
        estagio,
        justificativa: justificativa.trim(),
        ato: ato.trim() || null,
        nivel: territorio.nivel,
        territorio: territorio.nivel === 'MUNICIPIO' ? null : territorio.territorio,
      });
      toast.success(`${r.acionamento.estagioNome} acionado em ${s.territorio.nome}; ${r.acoesCriadas} ação(ões) no checklist.`);
      onFechar();
      onAcionado();
    } catch (err) {
      setErro(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(o) => !o && onFechar()}
      title={`Acionar estágio · ${s.territorio.nome}`}
      description="O estágio em vigor é encerrado na véspera e o novo começa hoje, com o checklist de ações do plano em vigor."
      footer={
        <Button onClick={acionar} loading={busy} disabled={tocado && erros.length > 0}>
          <Siren className="h-4 w-4" /> Acionar
        </Button>
      }
    >
      <div className="space-y-3">
        <Field
          label="Estágio"
          htmlFor="ct-acionar-estagio"
          hint={sugerido ? `Sugestão dos critérios na SE ${s.semanaReferencia.slice(4)}/${s.semanaReferencia.slice(0, 4)}: ${definicao.estagios.find((e) => e.chave === sugerido)?.nome ?? sugerido}.` : undefined}
        >
          <Select id="ct-acionar-estagio" value={estagio} onChange={(e) => setEstagio(e.target.value)}>
            <option value="">Escolha o estágio</option>
            {estagiosOrdenados(definicao).map((e) => (
              <option key={e.chave} value={e.chave}>
                {e.nome}
                {e.chave === s.estagioAtual.chave ? ' (em vigor)' : ''}
                {e.chave === sugerido ? ' (sugerido)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        {mesmo && <Alert tone="warn">Este já é o estágio em vigor. Acione outro estágio, ou registre de novo só se o estágio em vigor for de outra versão do plano.</Alert>}
        <Field label="Justificativa" htmlFor="ct-acionar-justificativa" hint={falta ? `Pelo menos ${MINIMO_JUSTIFICATIVA} caracteres (faltam ${falta}).` : 'Diga os critérios e a avaliação da sala de situação.'}>
          <Textarea id="ct-acionar-justificativa" rows={4} maxLength={4000} value={justificativa} onChange={(e) => setJustificativa(e.target.value)} />
        </Field>
        {proposta && !justificativa.trim() && (
          <Button size="sm" variant="secondary" onClick={() => setJustificativa(proposta)}>
            Usar os critérios atendidos como texto inicial
          </Button>
        )}
        <Field label="Ato (opcional)" htmlFor="ct-acionar-ato" hint="Ex.: Decreto municipal nº 123/2026, Portaria SMS nº 45/2026, ata do comitê.">
          <Input id="ct-acionar-ato" maxLength={300} value={ato} onChange={(e) => setAto(e.target.value)} />
        </Field>
        {tocado && erros.length > 0 && (
          <Alert tone="warn">
            <ul className="list-inside list-disc space-y-0.5">
              {erros.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </Alert>
        )}
        {erro && <Alert tone="error">{erro}</Alert>}
      </div>
    </Dialog>
  );
}
