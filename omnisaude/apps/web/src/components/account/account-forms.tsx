'use client';

import { KeyRound, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Barcode } from '@/components/ui/barcode';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useSession, type MfaSetupData } from '@/lib/session';

export function PasswordForm() {
  const toast = useToast();
  const session = useSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const mismatch = confirm.length > 0 && next !== confirm;
  return (
    <Card>
      <CardHeader title="Senha" description="Mínimo de 10 caracteres, com letras e números." />
      <CardBody>
        <form
          className="grid gap-3 sm:max-w-md"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await api.post('/auth/password', { current, next });
              toast.success('Senha alterada');
              setCurrent('');
              setNext('');
              setConfirm('');
              await session.refresh();
            } catch (err) {
              toast.error(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Senha atual" htmlFor="pw-current">
            <Input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </Field>
          <Field label="Nova senha" htmlFor="pw-next">
            <Input id="pw-next" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
          </Field>
          <Field label="Confirme a nova senha" htmlFor="pw-confirm" error={mismatch ? 'As senhas não conferem' : null}>
            <Input id="pw-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </Field>
          <Button type="submit" loading={busy} disabled={mismatch || next.length < 10} className="justify-self-start">
            <KeyRound className="h-4 w-4" /> Alterar senha
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

/** Verificação em duas etapas (TOTP): exigida pela trilha de assinatura dos registros clínicos. */
export function MfaSetup() {
  const session = useSession();
  const enabled = session.me?.user.mfaEnabled;
  return (
    <Card>
      <CardHeader
        title="Verificação em duas etapas"
        description="Use um aplicativo autenticador (Google Authenticator, Microsoft Authenticator, FreeOTP…)."
        actions={enabled ? <Badge tone="green">Ativa</Badge> : <Badge tone="amber">Inativa</Badge>}
      />
      <CardBody>
        <MfaEnroll
          buttonLabel={enabled ? 'Reconfigurar autenticador' : 'Ativar verificação em duas etapas'}
          buttonVariant={enabled ? 'secondary' : 'primary'}
          setup={() => api.post<MfaSetupData>('/auth/mfa/setup')}
          enable={(code, setupToken) => api.post('/auth/mfa/enable', { code, setupToken })}
          onDone={async () => {
            await session.refresh();
          }}
          doneMessage="Verificação em duas etapas ativada. Ela será pedida no próximo login."
        />
      </CardBody>
    </Card>
  );
}

/** Fluxo de configuração do autenticador: QR code, chave e confirmação do código. */
export function MfaEnroll({
  setup,
  enable,
  onDone,
  buttonLabel = 'Configurar autenticador',
  buttonVariant = 'primary',
  doneMessage = 'Autenticador configurado',
  autoStart = false,
}: {
  setup: () => Promise<MfaSetupData>;
  enable: (code: string, setupToken: string) => Promise<unknown>;
  onDone: () => Promise<void> | void;
  buttonLabel?: string;
  buttonVariant?: 'primary' | 'secondary';
  doneMessage?: string;
  autoStart?: boolean;
}) {
  const toast = useToast();
  const [data, setData] = useState<MfaSetupData | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    try {
      setData(await setup());
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (autoStart) void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

  return (
    <div className="flex flex-col gap-4">
      {!data && !autoStart && (
        <Button variant={buttonVariant} className="self-start" loading={busy} onClick={start}>
          <ShieldCheck className="h-4 w-4" /> {buttonLabel}
        </Button>
      )}
      {data && (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <Barcode kind="qrcode" value={data.otpauthUrl} scale={4} label="QR code do autenticador" className="inline-block shrink-0 rounded-lg border border-slate-200 bg-white p-2 [&>svg]:h-48 [&>svg]:w-48" />
          <div className="flex flex-col gap-3">
            <p className="text-sm text-slate-600">Leia o QR code no aplicativo ou digite a chave:</p>
            <code className="break-all rounded bg-slate-100 px-2 py-1 font-mono text-sm">{data.secret}</code>
            <Field label="Código gerado pelo aplicativo" htmlFor="mfa-code">
              <Input id="mfa-code" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoComplete="one-time-code" />
            </Field>
            <Button
              className="self-start"
              loading={busy}
              disabled={code.length !== 6}
              onClick={async () => {
                setBusy(true);
                try {
                  await enable(code, data.setupToken);
                  toast.success(doneMessage);
                  setData(null);
                  setCode('');
                  await onDone();
                } catch (err) {
                  toast.error(errorMessage(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Confirmar
            </Button>
            <Alert tone="info">O autenticador atual continua valendo até você confirmar o código do novo. O pedido expira em 10 minutos.</Alert>
          </div>
        </div>
      )}
    </div>
  );
}
