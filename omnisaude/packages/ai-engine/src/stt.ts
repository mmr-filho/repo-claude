import { AiEngineError } from './errors';

/** Transcrição de áudio gravado no servidor (o ditado ao vivo acontece no aparelho). */
export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
}

export interface Transcription {
  text: string;
  language?: string;
  segments?: TranscriptionSegment[];
}

export interface AudioInput {
  data: Uint8Array;
  mimeType: string;
  fileName?: string;
}

export interface SpeechToTextProvider {
  transcribe(audio: AudioInput, options?: { language?: string }): Promise<Transcription>;
}

export interface WhisperAsrProviderOptions {
  /** Ex.: http://whisper:9000 (container openai-whisper-asr-webservice, hospedado na infraestrutura do tenant). */
  baseUrl: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Cliente do serviço autohospedado openai-whisper-asr-webservice: o áudio não sai da rede do tenant. */
export class WhisperAsrProvider implements SpeechToTextProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: WhisperAsrProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async transcribe(audio: AudioInput, options: { language?: string } = {}): Promise<Transcription> {
    const url = new URL(`${this.baseUrl}/asr`);
    url.searchParams.set('task', 'transcribe');
    url.searchParams.set('language', options.language ?? 'pt');
    url.searchParams.set('output', 'json');
    url.searchParams.set('encode', 'true');

    const form = new FormData();
    form.append('audio_file', new Blob([audio.data], { type: audio.mimeType }), audio.fileName ?? 'ditado.webm');

    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: 'POST', body: form, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw new AiEngineError('Serviço de transcrição indisponível.', { cause: error });
    }
    if (!response.ok) throw new AiEngineError(`Serviço de transcrição respondeu ${response.status}.`);
    const body = (await response.json()) as { text?: string; language?: string; segments?: { start: number; end: number; text: string }[] };
    return {
      text: (body.text ?? '').trim(),
      ...(body.language ? { language: body.language } : {}),
      ...(body.segments ? { segments: body.segments.map((s) => ({ start: s.start, end: s.end, text: s.text.trim() })) } : {}),
    };
  }
}
