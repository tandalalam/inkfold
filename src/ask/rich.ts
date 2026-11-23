// Markdown + LaTeX rendering for assistant answers. Loaded lazily (KaTeX is large).
import { Marked, type TokenizerAndRendererExtension } from 'marked';
import katex from 'katex';
import 'katex/dist/katex.min.css';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function tex(src: string, display: boolean): string {
  return katex.renderToString(src.trim(), { displayMode: display, throwOnError: false, strict: 'ignore', trust: false, output: 'html' });
}

const DISPLAY = [/^\$\$([\s\S]+?)\$\$/, /^\\\[([\s\S]+?)\\\]/];
const INLINE = [/^\\\(([\s\S]+?)\\\)/, /^\$(?![\s$])((?:\\.|[^\\$\n])+?)(?<![\s\\])\$(?!\d)/];

const mathBlock: TokenizerAndRendererExtension = {
  name: 'mathBlock',
  level: 'block',
  start: (src) => {
    const m = /\$\$|\\\[/.exec(src);
    return m?.index;
  },
  tokenizer(src) {
    for (const re of DISPLAY) {
      const m = re.exec(src);
      if (m) {
        // swallow the rest of the line so the block ends cleanly
        const rest = /^[ \t]*(?:\n|$)/.exec(src.slice(m[0].length));
        if (!rest) return undefined;
        return { type: 'mathBlock', raw: m[0] + rest[0], text: m[1] };
      }
    }
    return undefined;
  },
  renderer: (t) => `<div class="math-display">${tex(t.text, true)}</div>`,
};

const mathInline: TokenizerAndRendererExtension = {
  name: 'mathInline',
  level: 'inline',
  start: (src) => {
    const m = /\$|\\\(|\\\[/.exec(src);
    return m?.index;
  },
  tokenizer(src) {
    for (const re of DISPLAY) {
      const m = re.exec(src);
      if (m) return { type: 'mathInline', raw: m[0], text: m[1], display: true };
    }
    for (const re of INLINE) {
      const m = re.exec(src);
      if (m) return { type: 'mathInline', raw: m[0], text: m[1], display: false };
    }
    return undefined;
  },
  renderer: (t) => (t.display ? `<span class="math-display">${tex(t.text, true)}</span>` : tex(t.text, false)),
};

const md = new Marked({ gfm: true, breaks: true });
md.use({
  extensions: [mathBlock, mathInline],
  renderer: {
    // Never let raw HTML from an answer into the page.
    html: ({ text }) => esc(text),
    link(token) {
      const inner = this.parser.parseInline(token.tokens);
      return /^https?:\/\//i.test(token.href)
        ? `<a href="${esc(token.href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
        : `<span class="local-link" title="${esc(token.href)}">${inner}</span>`;
    },
    image: ({ text }) => esc(text || ''),
  },
});

export function renderRich(src: string): string {
  return md.parse(src, { async: false }) as string;
}
