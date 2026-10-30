'use client';

import { Camera } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Alert } from '@/components/ui/misc';
import { fileToPhoto, type Photo } from '@/lib/native';

/** Captura pela webcam do computador da recepção (getUserMedia). */
export function WebcamDialog({ open, onOpenChange, onPhoto }: { open: boolean; onOpenChange: (o: boolean) => void; onPhoto: (p: Photo) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let stream: MediaStream | null = null;
    setError(null);
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } } })
      .then((s) => {
        stream = s;
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play();
        }
      })
      .catch(() => setError('Não foi possível acessar a câmera. Verifique a permissão do navegador.'));
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, [open]);

  async function capture() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext('2d')!.drawImage(v, 0, 0);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
    if (blob) {
      onPhoto(await fileToPhoto(blob));
      onOpenChange(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Fotografar documento"
      description="Posicione o documento inteiro, sem reflexos, e capture."
      size="lg"
      footer={
        <Button onClick={capture} disabled={!!error}>
          <Camera className="h-4 w-4" /> Capturar
        </Button>
      }
    >
      {error ? <Alert tone="error">{error}</Alert> : <video ref={video} className="aspect-video w-full rounded-lg bg-black" playsInline muted />}
    </Dialog>
  );
}
