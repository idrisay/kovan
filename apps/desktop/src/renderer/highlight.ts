/**
 * Syntax highlighting, from a language list chosen rather than inherited.
 *
 * `highlight.js/lib/core` plus explicit registrations, *not* the default
 * export: importing `highlight.js` whole pulls in ~190 grammars and roughly a
 * megabyte of parsed JavaScript, for a file viewer that will realistically
 * meet a dozen languages. Each `register` below is a deliberate cost.
 *
 * Highlighting is also never auto-detected. `highlightAuto` guesses from
 * content and gets short files wrong in ways that look like a rendering bug —
 * a three-line shell script reading as Perl. The extension is the better
 * signal, and a file whose extension we do not know renders as plain text,
 * which is honest.
 */

import hljs from 'highlight.js/lib/core';

import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import less from 'highlight.js/lib/languages/less';
import lua from 'highlight.js/lib/languages/lua';
import markdown from 'highlight.js/lib/languages/markdown';
import objectivec from 'highlight.js/lib/languages/objectivec';
import perl from 'highlight.js/lib/languages/perl';
import php from 'highlight.js/lib/languages/php';
import python from 'highlight.js/lib/languages/python';
import r from 'highlight.js/lib/languages/r';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

for (const [name, language] of Object.entries({
  bash, c, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json,
  kotlin, less, lua, markdown, objectivec, perl, php, python, r, ruby, rust,
  scss, sql, swift, typescript, xml, yaml
})) {
  hljs.registerLanguage(name, language);
}

/**
 * Extension to grammar.
 *
 * `.tsx` and `.jsx` map to `typescript` and `javascript`: highlight.js has no
 * separate JSX grammar, and both of those handle embedded JSX already.
 */
const BY_EXTENSION: Record<string, string> = {
  bash: 'bash', sh: 'bash', zsh: 'bash', fish: 'bash',
  c: 'c', h: 'c',
  cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp',
  css: 'css', less: 'less', scss: 'scss', sass: 'scss',
  diff: 'diff', patch: 'diff',
  go: 'go',
  cfg: 'ini', conf: 'ini', ini: 'ini', toml: 'ini',
  java: 'java',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  json: 'json', jsonc: 'json',
  kt: 'kotlin', kts: 'kotlin',
  lua: 'lua',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  m: 'objectivec', mm: 'objectivec',
  pl: 'perl', pm: 'perl',
  php: 'php',
  py: 'python', pyi: 'python', pyw: 'python',
  r: 'r',
  rb: 'ruby', rake: 'ruby', gemspec: 'ruby',
  rs: 'rust',
  sql: 'sql',
  swift: 'swift',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  htm: 'xml', html: 'xml', svg: 'xml', vue: 'xml', xml: 'xml', xhtml: 'xml',
  yaml: 'yaml', yml: 'yaml'
};

/** Files that carry their language in the whole name, not an extension. */
const BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'bash',
  '.bashrc': 'bash',
  '.zshrc': 'bash',
  '.env': 'ini',
  '.gitignore': 'bash',
  'gemfile': 'ruby',
  'rakefile': 'ruby'
};

export function languageFor(filePath: string): string | undefined {
  const name = filePath.split('/').pop()?.toLowerCase() ?? '';
  if (BY_NAME[name]) return BY_NAME[name];
  // `Dockerfile.dev` and `.eslintrc.json` both need the *last* dot segment.
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  return BY_EXTENSION[extension];
}

/**
 * Highlights a block of text and returns it split into one HTML string per
 * line, ready to drop into a line-numbered table.
 *
 * Why a block and not a line at a time: highlighting each line separately
 * loses all multi-line state, so the body of a block comment or a triple-quoted
 * string renders as ordinary code. highlight.js v11 has no public way to carry
 * state between calls — `highlight()` accepts no continuation and its result
 * exposes no `top`, which was verified against the library rather than assumed.
 *
 * So the whole block is highlighted at once and the resulting HTML is split at
 * its newlines, re-opening at the start of each line whatever spans were still
 * open at the end of the previous one. That is safe to do with string surgery
 * because highlight.js emits nothing but `<span class="…">`, `</span>` and
 * escaped text — no attributes containing `>`, and no newlines inside a tag.
 */
export function highlightBlock(text: string, filePath: string): string[] {
  const language = languageFor(filePath);
  if (!language || !hljs.getLanguage(language)) {
    return text.split('\n').map(escapeHtml);
  }
  try {
    return splitHighlightedLines(
      hljs.highlight(text, { language, ignoreIllegals: true }).value
    );
  } catch {
    // A grammar that throws must not take the viewer down with it.
    return text.split('\n').map(escapeHtml);
  }
}

const TAG = /<span[^>]*>|<\/span>/g;

/** Exported for its own test: the span re-opening is easy to get subtly wrong. */
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  let open: string[] = [];

  for (const line of html.split('\n')) {
    const stack = [...open];
    TAG.lastIndex = 0;
    for (let match = TAG.exec(line); match; match = TAG.exec(line)) {
      if (match[0] === '</span>') stack.pop();
      else stack.push(match[0]);
    }
    // Re-open what was open when the line began, and close what is still open
    // when it ends, so every line is independently well-formed HTML.
    lines.push(open.join('') + line + '</span>'.repeat(stack.length));
    open = stack;
  }
  return lines;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
