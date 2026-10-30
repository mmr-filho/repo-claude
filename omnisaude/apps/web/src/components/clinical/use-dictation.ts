'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { dictationAvailable, startDictation, type Dictation } from '@/lib/native';

/** Estado do ditado: acumula frases finais e mostra o texto provisório enquanto a pessoa fala. */
export function useDictation(onError: (msg: string) => void) {
  const [active, setActive] = useState(false);
  const [partial, setPartial] = useState('');
  const [text, setText] = useState('');
  const handle = useRef<Dictation | null>(null);
  const acc = useRef('');
  const [available, setAvailable] = useState(false);
  useEffect(() => setAvailable(dictationAvailable()), []);

  const start = useCallback(async () => {
    acc.current = '';
    setText('');
    setPartial('');
    try {
      handle.current = await startDictation(
        (t) => {
          acc.current = `${acc.current} ${t}`.trim();
          setText(acc.current);
          setPartial('');
        },
        (p) => setPartial(p),
        onError,
      );
      setActive(true);
    } catch (err) {
      onError((err as Error).message);
    }
  }, [onError]);

  /** Para e devolve todo o texto ditado. */
  const stop = useCallback(async () => {
    await handle.current?.stop();
    handle.current = null;
    setActive(false);
    setPartial('');
    return acc.current;
  }, []);

  return { available, active, partial, text, start, stop };
}
