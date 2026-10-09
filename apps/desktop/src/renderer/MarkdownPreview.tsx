import { useEffect, useMemo, useRef } from 'react';
import { Marked } from 'marked';
import createDOMPurify from 'dompurify';

/**
 * A Markdown file from the workspace, rendered (item 161), as VS Code's
 * preview: headings, tables, task lists, code, and the file's own images.
 *
 * The file is the user's, but it can be anything a clone brought in, so it
 * goes through DOMPurify like a pull request body does (`Prose`). Its own
 * instance: the hook below, which holds local images back for main to read,
 * must not touch `Prose`.
 *
 * Images: a relative `src` is resolved against the file's folder and read by
 * main (`workspaceImage`), which only reads inside a workspace. Web images
 * load as they are. Links: web ones open in the browser, `#heading` scrolls,
 * and a relative one opens that file in a Kovan tab.
 */

const purify = createDOMPurify(window);

// The browser would otherwise try a relative `src` against the app's own
// files; it waits in `data-local` until main has read it.
purify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName !== 'IMG') return;
  const src = node.getAttribute('src') ?? '';
  if (src && !hasScheme(src)) {
    node.setAttribute('data-local', src);
    node.removeAttribute('src');
  }
});

const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'strong', 'em', 'del', 's', 'code', 'pre', 'blockquote', 'kbd', 'sup', 'sub',
  'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'details', 'summary',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img', 'input'
];

const hasScheme = (url: string) => /^[a-z][a-z0-9+.-]*:/i.test(url);

/** GitHub's heading anchors: "## 1. Status at a glance" → "1-status-at-a-glance". */
export function slug(text: string): string {
  return text.trim().toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

/** `images/a b.png` beside `/x/notes/r.md` → `/x/notes/images/a b.png`. */
export function resolveLocal(file: string, target: string): string {
  const clean = decodeURI(target.replace(/[?#].*$/, ''));
  const parts = clean.startsWith('/') ? [] : file.split('/').slice(0, -1);
  for (const part of clean.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return `/${parts.filter(Boolean).join('/')}`;
}

function render(text: string): string {
  const seen = new Map<string, number>();
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth, text: raw }) {
        // Repeated headings get -1, -2, as on GitHub, so every anchor works.
        const base = slug(raw);
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        const id = n === 0 ? base : `${base}-${n}`;
        return `<h${depth} id="${id}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      }
    }
  });
  return purify.sanitize(marked.parse(text, { async: false }) as string, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['href', 'title', 'alt', 'src', 'type', 'checked', 'disabled', 'id', 'align', 'start', 'open'],
    // Web, mail, inline images, and paths with no scheme at all (the file's own).
    ALLOWED_URI_REGEXP: /^(?:https?|mailto):|^data:image\/(?:png|jpe?g|gif|webp);base64,|^(?![a-z][a-z0-9+.-]*:)/i,
    ADD_URI_SAFE_ATTR: ['type']
  });
}

export function MarkdownPreview({ path, text, onOpenFile }: {
  /** The file's own path, for its relative images and links. */
  path: string;
  text: string;
  onOpenFile: (path: string) => void;
}) {
  const html = useMemo(() => render(text), [text]);
  const box = useRef<HTMLDivElement>(null);
  // Read once per preview: typing re-renders the HTML, not the images.
  const images = useRef(new Map<string, Promise<string | undefined>>());

  useEffect(() => {
    const root = box.current;
    if (!root) return;
    for (const img of root.querySelectorAll<HTMLImageElement>('img[data-local]')) {
      const file = resolveLocal(path, img.dataset['local'] ?? '');
      let read = images.current.get(file);
      if (!read) {
        read = window.kovan.workspaceImage(file).catch(() => undefined);
        images.current.set(file, read);
      }
      void read.then((url) => {
        if (url) img.src = url;
        else {
          img.classList.add('missing');
          img.title = `Can't show ${img.dataset['local']}: not found in the workspace, not an image, or over 10 MB`;
        }
      });
    }
  }, [html, path]);

  return (
    <div
      ref={box}
      className="prose md-preview"
      // Sanitised in `render`; see the note at the top.
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(event) => {
        const link = (event.target as Element).closest('a');
        const href = link?.getAttribute('href');
        if (!link || !href) return;
        event.preventDefault();
        if (href.startsWith('#')) {
          box.current?.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`)?.scrollIntoView({ block: 'start' });
        } else if (/^(?:https?|mailto):/i.test(href)) {
          void window.kovan.openExternal(href);
        } else if (!hasScheme(href)) {
          onOpenFile(resolveLocal(path, href));
        }
      }}
    />
  );
}
