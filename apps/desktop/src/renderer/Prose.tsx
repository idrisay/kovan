import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * Markdown from a pull request body, a review comment or a Jira issue.
 *
 * This is other people's text rendered as HTML inside a renderer that holds a
 * bridge to the main process, so it goes through DOMPurify — not as a
 * formality. The earlier version side-stepped the problem by printing the
 * source verbatim, which was safe and unreadable: the design expects prose,
 * and `## Summary` on screen is not prose.
 *
 * Sanitising, not escaping: the allow-list below is what a comment legitimately
 * contains. Anything else — script, iframe, event handlers, `javascript:` —
 * is removed rather than encoded.
 */

marked.setOptions({ gfm: true, breaks: true });

const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img', 'input'
];

export function Prose({ text }: { text: string }) {
  const html = useMemo(() => {
    if (!text) return '';
    const raw = marked.parse(text, { async: false }) as string;
    return DOMPurify.sanitize(raw, {
      ALLOWED_TAGS,
      ALLOWED_ATTR: ['href', 'title', 'alt', 'src', 'type', 'checked', 'disabled'],
      // Only these schemes may appear in an href or src; `javascript:` and
      // `data:` are what this excludes.
      ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i
    });
  }, [text]);

  if (!text) {
    return <p className="quiet">Nothing written.</p>;
  }
  return (
    <div
      className="prose"
      // Sanitised immediately above; see the note on why this is rendered
      // rather than escaped.
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(event) => {
        // Links open in the browser, never in the app window — a navigation
        // here would replace the renderer with somebody's web page.
        const anchor = (event.target as HTMLElement).closest('a');
        if (anchor?.href) {
          event.preventDefault();
          void window.baton.openExternal(anchor.href);
        }
      }}
    />
  );
}
