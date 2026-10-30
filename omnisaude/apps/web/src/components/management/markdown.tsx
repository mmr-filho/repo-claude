import { Fragment } from 'react';

/**
 * Renderizador mínimo de Markdown (títulos, listas com um nível de aninhamento, negrito, parágrafos)
 * para as pautas geradas pela API. O texto é tratado como texto: nada de HTML é interpretado.
 */
export function Markdown({ source }: { source: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = source.split('\n');
  let list: { text: string; children: string[] }[] = [];
  const flush = (key: number) => {
    if (!list.length) return;
    blocks.push(
      <ul key={`ul-${key}`} className="mb-3 list-disc space-y-1 pl-5">
        {list.map((li, i) => (
          <li key={i}>
            <Inline text={li.text} />
            {li.children.length > 0 && (
              <ul className="mt-1 list-[circle] space-y-0.5 pl-5">
                {li.children.map((c, j) => (
                  <li key={j}>
                    <Inline text={c} />
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>,
    );
    list = [];
  };
  lines.forEach((line, i) => {
    const sub = /^\s{2,}[-*]\s+(.*)$/.exec(line);
    const item = /^[-*]\s+(.*)$/.exec(line);
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (sub && list.length) {
      list[list.length - 1]!.children.push(sub[1]!);
      return;
    }
    if (item) {
      list.push({ text: item[1]!, children: [] });
      return;
    }
    flush(i);
    if (h) {
      const level = h[1]!.length;
      const cls = level === 1 ? 'mb-3 text-xl font-semibold' : level === 2 ? 'mb-2 mt-5 text-base font-semibold text-brand-800' : 'mb-2 mt-3 font-semibold';
      blocks.push(
        level === 1 ? (
          <h2 key={i} className={cls}>
            <Inline text={h[2]!} />
          </h2>
        ) : (
          <h3 key={i} className={cls}>
            <Inline text={h[2]!} />
          </h3>
        ),
      );
    } else if (line.trim()) {
      blocks.push(
        <p key={i} className="mb-3">
          <Inline text={line} />
        </p>,
      );
    }
  });
  flush(lines.length);
  return <div className="text-sm leading-relaxed text-slate-800">{blocks}</div>;
}

function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('**') && p.endsWith('**') ? (
          <strong key={i}>{p.slice(2, -2)}</strong>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}
