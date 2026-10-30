'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Área de impressão: o conteúdo fica oculto na tela e, ao imprimir, só ele aparece
 * (funciona também a partir de diálogos). Use com window.print().
 */
export function PrintPortal({ children }: { children: React.ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const div = document.createElement('div');
    div.id = 'omni-print-area';
    document.body.appendChild(div);
    setEl(div);
    return () => div.remove();
  }, []);
  if (!el) return null;
  return createPortal(
    <>
      <style>{`@media screen{#omni-print-area{display:none}}@media print{body>*:not(#omni-print-area){display:none!important}#omni-print-area{display:block;padding:8mm}}`}</style>
      {children}
    </>,
    el,
  );
}

/** Imprime quando a área de impressão estiver pronta (códigos QR carregados), com limite de espera. */
export function printSoon() {
  const started = Date.now();
  const tick = () => {
    const area = document.getElementById('omni-print-area');
    const pending = !area || !area.firstChild || area.querySelector('.animate-pulse');
    if (pending && Date.now() - started < 4000) setTimeout(tick, 150);
    else window.print();
  };
  setTimeout(tick, 200);
}
