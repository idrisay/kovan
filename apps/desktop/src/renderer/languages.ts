/**
 * Languages, for both the editor and the diff.
 *
 * One highlighter, not two. The read-only viewer used highlight.js and the
 * editor needs CodeMirror, which brings its own grammars — shipping both would
 * be two parsers doing the same job in the same window, and two sets of CSS
 * classes to theme. CodeMirror's Lezer trees drive both here: `highlightLines`
 * renders a static string for the diff, and `languageExtension` hands the same
 * grammar to a live editor.
 *
 * Highlighting is keyed on the file extension, never auto-detected. Guessing
 * from content reads a three-line shell script as Perl, which looks like a
 * rendering bug rather than a guess.
 *
 * Both paths emit `tok-*` classes from Lezer's own `classHighlighter` rather
 * than a CodeMirror theme object, so the colours live in styles.css beside the
 * rest of the design language instead of in a JS object nobody thinks to look at.
 */

import { StreamLanguage, type LanguageSupport, type Language } from '@codemirror/language';
import { classHighlighter, highlightCode } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

import { cpp } from '@codemirror/lang-cpp';
import { css } from '@codemirror/lang-css';
import { go } from '@codemirror/lang-go';
import { html } from '@codemirror/lang-html';
import { java } from '@codemirror/lang-java';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { php } from '@codemirror/lang-php';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { sql } from '@codemirror/lang-sql';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';

// Grammars CodeMirror has no first-party package for. These are the old
// CodeMirror 5 stream parsers, which are less precise than a Lezer grammar but
// are the difference between coloured Swift and grey Swift.
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { perl } from '@codemirror/legacy-modes/mode/perl';
import { r } from '@codemirror/legacy-modes/mode/r';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { kotlin, csharp, objectiveC } from '@codemirror/legacy-modes/mode/clike';

/** Built once each, on first use: parsing a grammar table is not free. */
const cache = new Map<string, LanguageSupport | Language>();

type Factory = () => LanguageSupport | Language;

const FACTORY: Record<string, Factory> = {
  cpp: () => cpp(),
  csharp: () => StreamLanguage.define(csharp),
  css: () => css(),
  dockerfile: () => StreamLanguage.define(dockerFile),
  go: () => go(),
  html: () => html(),
  java: () => java(),
  javascript: () => javascript({ jsx: true }),
  json: () => json(),
  kotlin: () => StreamLanguage.define(kotlin),
  lua: () => StreamLanguage.define(lua),
  markdown: () => markdown(),
  objectivec: () => StreamLanguage.define(objectiveC),
  perl: () => StreamLanguage.define(perl),
  php: () => php(),
  python: () => python(),
  r: () => StreamLanguage.define(r),
  ruby: () => StreamLanguage.define(ruby),
  rust: () => rust(),
  shell: () => StreamLanguage.define(shell),
  sql: () => sql(),
  swift: () => StreamLanguage.define(swift),
  toml: () => StreamLanguage.define(toml),
  typescript: () => javascript({ jsx: true, typescript: true }),
  xml: () => xml(),
  yaml: () => yaml()
};

const BY_EXTENSION: Record<string, string> = {
  bash: 'shell', sh: 'shell', zsh: 'shell', fish: 'shell', bashrc: 'shell',
  c: 'cpp', h: 'cpp', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp',
  css: 'css', less: 'css', scss: 'css', sass: 'css',
  go: 'go',
  htm: 'html', html: 'html', vue: 'html', xhtml: 'html',
  java: 'java',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  json: 'json', jsonc: 'json', webmanifest: 'json',
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
  toml: 'toml',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  svg: 'xml', xml: 'xml', xsl: 'xml', plist: 'xml',
  yaml: 'yaml', yml: 'yaml'
};

/** Files whose whole name is the signal, not an extension. */
const BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'shell',
  gemfile: 'ruby',
  rakefile: 'ruby',
  '.bashrc': 'shell',
  '.zshrc': 'shell',
  '.zprofile': 'shell',
  '.env': 'shell',
  '.gitignore': 'shell',
  '.npmrc': 'shell'
};

/** The grammar's name, for the status bar. `undefined` means plain text. */
export function languageFor(filePath: string): string | undefined {
  const name = filePath.split('/').pop()?.toLowerCase() ?? '';
  if (BY_NAME[name]) return BY_NAME[name];
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  return BY_EXTENSION[extension];
}

function support(id: string | undefined): LanguageSupport | Language | undefined {
  if (!id) return undefined;
  const existing = cache.get(id);
  if (existing) return existing;
  const factory = FACTORY[id];
  if (!factory) return undefined;
  const built = factory();
  cache.set(id, built);
  return built;
}

/** The CodeMirror extension for a file, or nothing for an unknown type. */
export function languageExtension(filePath: string): Extension | undefined {
  return support(languageFor(filePath)) as Extension | undefined;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Highlights a block and returns one HTML string per line.
 *
 * Used by the diff, which renders a line-numbered table and so cannot take one
 * blob of HTML with spans straddling newlines. Lezer splits at the newlines
 * itself, through the `putBreak` callback, closing and reopening whatever was
 * open — which is why a multi-line string stays coloured on its second line.
 */
export function highlightLines(code: string, filePath: string): string[] {
  const language = support(languageFor(filePath));
  if (!language) {
    return code.split('\n').map(escapeHtml);
  }

  const parser = 'language' in language ? language.language.parser : language.parser;
  const lines: string[] = [];
  let current = '';

  try {
    highlightCode(
      code,
      parser.parse(code),
      classHighlighter,
      (text, classes) => {
        current += classes ? `<span class="${classes}">${escapeHtml(text)}</span>` : escapeHtml(text);
      },
      () => {
        lines.push(current);
        current = '';
      }
    );
  } catch {
    // A grammar that throws must not take the diff down with it.
    return code.split('\n').map(escapeHtml);
  }

  lines.push(current);
  return lines;
}
