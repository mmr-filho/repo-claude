'use client';

import { Camera, ScanLine } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { browserBarcodeDetector, isNative, scanWithNativeScanner } from '@/lib/native';

export interface ScanInputHandle {
  focus(): void;
  clear(): void;
}

interface Props {
  /** Chamado com o código completo (Enter do leitor USB/Bluetooth, câmera ou digitação). */
  onScan: (code: string) => void;
  placeholder?: string;
  label?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  /** Botões e campo maiores para a operação no celular. */
  large?: boolean;
  className?: string;
}

/**
 * Campo de leitura de códigos: aceita leitores tipo "teclado" (que digitam o código e um Enter),
 * o leitor nativo do Android (ML Kit) e, no navegador, a câmera com BarcodeDetector.
 * O separador GS1 (0x1D) é preservado; alguns leitores o enviam como "^]" ou "<GS>", que normalizamos.
 */
export const ScanInput = forwardRef<ScanInputHandle, Props>(function ScanInput(
  { onScan, placeholder = 'Leia o código ou digite', label = 'Código lido', autoFocus, disabled, large, className },
  ref,
) {
  const [value, setValue] = useState('');
  const [camera, setCamera] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus(), clear: () => setValue('') }));

  const submit = useCallback(
    (raw: string) => {
      const code = raw.replace(/<GS>|\^\]|\\x1d/gi, '\u001d').trim();
      if (!code) return;
      onScan(code);
      setValue('');
    },
    [onScan],
  );

  async function openCamera() {
    if (isNative()) {
      try {
        const code = await scanWithNativeScanner();
        if (code) submit(code);
      } catch (err) {
        toast.error((err as Error).message);
      }
      return;
    }
    if (!browserBarcodeDetector()) {
      toast.info('Leitura pela câmera indisponível neste navegador: use o leitor de código ou digite.');
      inputRef.current?.focus();
      return;
    }
    setCamera(true);
  }

  return (
    <div className={cn('flex gap-2', className)}>
      <div className="relative flex-1">
        <ScanLine className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit(value);
            }
          }}
          placeholder={placeholder}
          aria-label={label}
          autoFocus={autoFocus}
          disabled={disabled}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          className={cn('pl-9 font-mono', large && 'h-14 text-base')}
        />
      </div>
      <Button variant="secondary" size={large ? 'lg' : 'md'} onClick={openCamera} disabled={disabled} aria-label="Ler com a câmera" title="Ler com a câmera" className={large ? 'h-14' : undefined}>
        <Camera className="h-5 w-5" />
        <span className="hidden sm:inline">Câmera</span>
      </Button>
      {!large && (
        <Button variant="ghost" onClick={() => submit(value)} disabled={disabled || !value.trim()}>
          OK
        </Button>
      )}
      {large && value.trim() && (
        <Button size="lg" className="h-14" onClick={() => submit(value)} disabled={disabled}>
          OK
        </Button>
      )}
      <CameraScanDialog
        open={camera}
        onOpenChange={setCamera}
        onDetected={(code) => {
          setCamera(false);
          submit(code);
        }}
      />
    </div>
  );
});

/** Pré-visualização da câmera traseira com detecção contínua (navegadores com BarcodeDetector). */
function CameraScanDialog({ open, onOpenChange, onDetected }: { open: boolean; onOpenChange: (o: boolean) => void; onDetected: (code: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const detected = useRef(onDetected);
  detected.current = onDetected;

  useEffect(() => {
    if (!open) return;
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const detector = browserBarcodeDetector();
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        const video = videoRef.current;
        if (!video || stopped) return;
        video.srcObject = stream;
        await video.play();
        const tick = async () => {
          if (stopped || !detector) return;
          try {
            const found = await detector.detect(video);
            if (found[0]?.rawValue) {
              detected.current(found[0].rawValue);
              return;
            }
          } catch {
            // quadro ainda não disponível
          }
          timer = setTimeout(tick, 250);
        };
        void tick();
      } catch (err) {
        setError((err as Error).name === 'NotAllowedError' ? 'Permissão de câmera negada.' : 'Não foi possível abrir a câmera.');
      }
    })();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Ler código com a câmera" description="Aponte para o Datamatrix, QR Code ou código de barras.">
      {error ? (
        <p className="text-sm text-red-700">{error}</p>
      ) : (
        <div className="relative overflow-hidden rounded-lg bg-black">
          <video ref={videoRef} className="aspect-video w-full object-cover" muted playsInline />
          <div className="pointer-events-none absolute inset-8 rounded-lg border-2 border-white/70" aria-hidden />
        </div>
      )}
    </Dialog>
  );
}
