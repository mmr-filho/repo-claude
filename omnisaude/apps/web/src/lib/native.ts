'use client';

/**
 * Recursos de hardware com dois caminhos: plugin nativo no app Android (Capacitor) e API do navegador
 * na versão web. Os plugins são carregados sob demanda para não pesar no carregamento das telas.
 */

export function isNative(): boolean {
  if (typeof window === 'undefined') return false;
  return !!(window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
}

// ───────────── Leitura de códigos (Datamatrix GS1, QR da pulseira, código de barras) ─────────────

/** Abre o leitor nativo (ML Kit). Na web, devolve null e a tela usa o leitor por câmera ou o leitor USB. */
export async function scanWithNativeScanner(): Promise<string | null> {
  if (!isNative()) return null;
  const { BarcodeScanner, BarcodeFormat } = await import('@capacitor-mlkit/barcode-scanning');
  const perm = await BarcodeScanner.requestPermissions();
  if (perm.camera !== 'granted' && perm.camera !== 'limited') throw new Error('Permissão de câmera negada');
  const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.DataMatrix, BarcodeFormat.QrCode, BarcodeFormat.Code128, BarcodeFormat.Ean13] });
  return barcodes[0]?.rawValue ?? null;
}

type Detector = { detect(source: CanvasImageSource): Promise<{ rawValue: string }[]> };

/** Leitor pela câmera do navegador (BarcodeDetector), quando disponível. */
export function browserBarcodeDetector(): Detector | null {
  const BD = (globalThis as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
  return BD ? new BD({ formats: ['data_matrix', 'qr_code', 'code_128', 'ean_13'] }) : null;
}

// ───────────── Câmera (OCR de documentos) ─────────────

export interface Photo {
  base64: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
}

export async function takeNativePhoto(): Promise<Photo | null> {
  if (!isNative()) return null;
  const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera');
  const photo = await Camera.getPhoto({ resultType: CameraResultType.Base64, source: CameraSource.Camera, quality: 85, width: 1800, correctOrientation: true });
  if (!photo.base64String) return null;
  return { base64: photo.base64String, mediaType: photo.format === 'png' ? 'image/png' : 'image/jpeg' };
}

/** Lê um arquivo de imagem (input type=file ou captura da webcam) e reduz para no máximo 1800 px. */
export async function fileToPhoto(file: Blob, maxSize = 1800): Promise<Photo> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  return { base64: dataUrl.split(',')[1]!, mediaType: 'image/jpeg' };
}

// ───────────── Voz: ditado (fala → texto) e leitura em voz alta (texto → fala) ─────────────

export interface Dictation {
  stop(): Promise<void>;
}

type WebSpeechRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};

export function dictationAvailable(): boolean {
  if (isNative()) return true;
  const w = globalThis as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  return !!(w.SpeechRecognition ?? w.webkitSpeechRecognition);
}

/**
 * Ditado contínuo em português. onText recebe o trecho final de cada frase; onPartial, o texto provisório.
 * No app usa o reconhecimento do Android (com cancelamento de ruído do aparelho).
 */
export async function startDictation(onText: (text: string) => void, onPartial?: (text: string) => void, onError?: (msg: string) => void): Promise<Dictation> {
  if (isNative()) {
    const { SpeechRecognition } = await import('@capacitor-community/speech-recognition');
    await SpeechRecognition.requestPermissions();
    let last = '';
    const handle = await SpeechRecognition.addListener('partialResults', (data: { matches?: string[] }) => {
      last = data.matches?.[0] ?? '';
      onPartial?.(last);
    });
    await SpeechRecognition.start({ language: 'pt-BR', partialResults: true, popup: false });
    return {
      async stop() {
        await SpeechRecognition.stop();
        await handle.remove();
        if (last) onText(last);
      },
    };
  }
  const w = globalThis as unknown as { SpeechRecognition?: new () => WebSpeechRecognition; webkitSpeechRecognition?: new () => WebSpeechRecognition };
  const Rec = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Rec) throw new Error('Ditado por voz não disponível neste navegador');
  const rec = new Rec();
  let active = true;
  rec.lang = 'pt-BR';
  rec.continuous = true;
  rec.interimResults = true;
  rec.onresult = (e) => {
    let partial = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]!;
      if (r.isFinal) onText(r[0].transcript.trim());
      else partial += r[0].transcript;
    }
    onPartial?.(partial);
  };
  rec.onerror = (e) => onError?.(e.error === 'not-allowed' ? 'Permissão de microfone negada' : `Erro no ditado: ${e.error}`);
  // O navegador encerra sozinho após silêncio; reinicia enquanto o usuário não parar.
  rec.onend = () => {
    if (active) rec.start();
  };
  rec.start();
  return {
    async stop() {
      active = false;
      rec.stop();
    },
  };
}

/** Lê um texto em voz alta (chamada de senhas, instruções de uso de medicamentos). */
export async function speak(text: string, rate = 1): Promise<void> {
  if (isNative()) {
    const { TextToSpeech } = await import('@capacitor-community/text-to-speech');
    await TextToSpeech.speak({ text, lang: 'pt-BR', rate });
    return;
  }
  if (typeof speechSynthesis === 'undefined') return;
  await new Promise<void>((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'pt-BR';
    u.rate = rate;
    const voice = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith('pt'));
    if (voice) u.voice = voice;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}

// ───────────── Sinais sonoros (aprovação / bloqueio na administração beira-leito) ─────────────

export function beep(kind: 'APROVADO' | 'BLOQUEIO') {
  if (typeof window === 'undefined') return;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return;
  const ctx = new AC();
  const tones = kind === 'APROVADO' ? [880, 1320] : [220, 180, 220];
  tones.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = kind === 'APROVADO' ? 'sine' : 'square';
    osc.frequency.value = freq;
    gain.gain.value = 0.15;
    osc.connect(gain).connect(ctx.destination);
    const start = ctx.currentTime + i * 0.18;
    osc.start(start);
    osc.stop(start + 0.15);
  });
  if (isNative() && 'vibrate' in navigator) navigator.vibrate(kind === 'APROVADO' ? 80 : [200, 80, 200]);
}
