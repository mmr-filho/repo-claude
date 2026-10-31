'use client';

import { PARENTESCO, type OperacaoCampo, type PessoaCampo } from '@omnisaude/shared';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { uuid } from '@/lib/offline';
import { PessoaCampos, pessoaParaOp, pessoaValida, pessoaVazia, type PessoaForm } from './person-fields';

/** Nova pessoa numa família do território (cadastro individual mínimo), com o parentesco com o responsável. */
export function PersonForm({
  aberto,
  onClose,
  familia,
  endereco,
  onSalvar,
}: {
  aberto: boolean;
  onClose: () => void;
  familia: { id: string; pendente: boolean; rotulo: string } | null;
  endereco: PessoaCampo['endereco'];
  onSalvar: (op: OperacaoCampo, rotulo: string) => Promise<void>;
}) {
  const [pessoa, setPessoa] = useState<PessoaForm>(pessoaVazia());
  const [kinship, setKinship] = useState('09');
  const [erro, setErro] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (aberto) {
      setPessoa(pessoaVazia());
      setKinship('09');
      setErro(null);
    }
  }, [aberto]);

  async function salvar() {
    const invalido = pessoaValida(pessoa);
    if (invalido) return setErro(invalido);
    const op: OperacaoCampo = {
      tipo: 'PESSOA',
      clientId: uuid(),
      registradoEm: new Date().toISOString(),
      dados: pessoaParaOp(pessoa, endereco),
      ...(familia ? (familia.pendente ? { familiaClientId: familia.id } : { familyId: familia.id }) : {}),
      kinship,
    };
    setBusy(true);
    try {
      await onSalvar(op, `Nova pessoa · ${pessoa.name.trim()}${familia ? ` · ${familia.rotulo}` : ''}`);
      onClose();
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={aberto}
      onOpenChange={(o) => !o && onClose()}
      title="Nova pessoa na família"
      description={familia?.rotulo ?? 'Cadastro individual'}
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={salvar} loading={busy} id="pessoa-salvar">
            Salvar
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {erro && <Alert tone="error">{erro}</Alert>}
        <Field label="Parentesco com o responsável" htmlFor="pessoa-parentesco">
          <Select id="pessoa-parentesco" value={kinship} onChange={(e) => setKinship(e.target.value)}>
            {Object.entries(PARENTESCO).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <PessoaCampos valor={pessoa} onChange={setPessoa} prefixo="pessoa" />
      </div>
    </Dialog>
  );
}
