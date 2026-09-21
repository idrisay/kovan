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
      // Only these schemes may appear in an href or src; `javascript:` and any
      // other `data:` payload are what this excludes. The base64 image form is
      // let through because a Jira attachment arrives inlined that way — see
      // `JiraClient.attachmentDataUrl` — never as a fetchable https URL.
      ALLOWED_URI_REGEXP:
        /^(?:https?|mailto):|^data:image\/(?:png|jpe?g|gif|webp);base64,/i,
      // DOMPurify runs that same URI regexp over every attribute value that
      // isn't on this list, not just href/src — so without it, `type` on a
      // task-list checkbox (a non-URI value like "checkbox") fails the check
      // and gets silently dropped, leaving a bare `<input>` that renders as a
      // plain text box instead of a checkbox.
      ADD_URI_SAFE_ATTR: ['type']
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
