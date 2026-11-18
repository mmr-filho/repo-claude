import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TabPanel, Tabs } from '../src/components/ui/tabs';

/*
 * Ponto K4: a lista de abas tinha o nome fixo "Seções". Com as abas aninhadas da semana 27 (consolidação > diagrama >
 * receita; surto > ficha...), o leitor de tela anunciava várias listas com o mesmo nome. Agora o nome vem por
 * propriedade (padrão "Seções") e cada lista aninhada da semana passa o seu.
 */

const abas = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(Tabs, { value: 'a', onValueChange: () => {}, tabs: [{ value: 'a', label: 'A' }], ...props } as Parameters<typeof Tabs>[0], createElement(TabPanel, { value: 'a' }, 'conteúdo')));

describe('nome da lista de abas', () => {
  it('sem a propriedade, "Seções" (as outras telas não mudam)', () => {
    expect(abas({})).toContain('role="tablist"');
    expect(abas({})).toContain('aria-label="Seções"');
  });

  it('com a propriedade, o nome dado', () => {
    const html = abas({ 'aria-label': 'Seções do diagrama de controle' });
    expect(html).toContain('aria-label="Seções do diagrama de controle"');
    expect(html).not.toContain('aria-label="Seções"');
  });

  it('toda lista de abas das telas da semana 27 tem nome próprio, e os nomes não se repetem', () => {
    const pasta = fileURLToPath(new URL('../src/components/consolidacao/', import.meta.url));
    const pagina = fileURLToPath(new URL('../src/app/(app)/vigilancia/consolidacao/page.tsx', import.meta.url));
    const fontes = [
      ...readdirSync(pasta)
        .filter((f) => f.endsWith('.tsx'))
        .map((f) => `${pasta}${f}`),
      pagina,
    ];
    const nomes: string[] = [];
    for (const arquivo of fontes) {
      const texto = readFileSync(arquivo, 'utf8');
      // Cada <Tabs ...> até o fim da tag de abertura (as props podem ocupar várias linhas).
      for (const m of texto.matchAll(/<Tabs\b([\s\S]*?)tabs=/g)) {
        const nome = /aria-label="([^"]+)"/.exec(m[1]!)?.[1];
        expect(nome, `lista de abas sem nome em ${arquivo}`).toBeTruthy();
        nomes.push(nome!);
      }
    }
    expect(nomes.length).toBeGreaterThanOrEqual(8);
    expect(new Set(nomes).size).toBe(nomes.length);
    expect(nomes).not.toContain('Seções');
  });
});
