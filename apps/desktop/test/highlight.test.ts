import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  highlightBlock,
  languageFor,
  splitHighlightedLines
} from '../src/renderer/highlight';

describe('languageFor', () => {
  it('maps the extensions people actually open', () => {
    expect(languageFor('/a/b/main.py')).toBe('python');
    expect(languageFor('/a/b/App.tsx')).toBe('typescript');
    expect(languageFor('/a/b/index.mjs')).toBe('javascript');
    expect(languageFor('/a/b/Cargo.toml')).toBe('ini');
    expect(languageFor('/a/b/style.scss')).toBe('scss');
  });

  it('uses the last dot segment, not the first', () => {
    expect(languageFor('.eslintrc.json')).toBe('json');
    expect(languageFor('docker-compose.prod.yml')).toBe('yaml');
  });

  it('recognises files whose whole name is the signal', () => {
    expect(languageFor('/repo/Dockerfile')).toBe('dockerfile');
    expect(languageFor('/repo/Makefile')).toBe('bash');
  });

  it('returns nothing for an unknown extension rather than guessing', () => {
    expect(languageFor('/a/b/data.bin')).toBeUndefined();
    expect(languageFor('/a/b/LICENSE')).toBeUndefined();
  });
});

describe('splitHighlightedLines', () => {
  it('leaves plain lines alone', () => {
    expect(splitHighlightedLines('a\nb')).toEqual(['a', 'b']);
  });

  it('closes and re-opens a span that straddles a newline', () => {
    // This is the whole point: without it, line two would carry a stray
    // closing tag and line one would be left open, and React would render
    // the rest of the file inside a string.
    expect(splitHighlightedLines('<span class="hljs-string">one\ntwo</span>')).toEqual([
      '<span class="hljs-string">one</span>',
      '<span class="hljs-string">two</span>'
    ]);
  });

  it('handles nesting across several lines', () => {
    expect(
      splitHighlightedLines('<span class="a"><span class="b">x\ny</span>\nz</span>')
    ).toEqual([
      '<span class="a"><span class="b">x</span></span>',
      '<span class="a"><span class="b">y</span></span>',
      '<span class="a">z</span>'
    ]);
  });

  it('keeps every line independently balanced', () => {
    for (const line of splitHighlightedLines('<span class="hljs-comment">a\nb\nc</span>')) {
      const opens = line.match(/<span[^>]*>/g)?.length ?? 0;
      const closes = line.match(/<\/span>/g)?.length ?? 0;
      expect(opens).toBe(closes);
    }
  });

  it('is not confused by a blank line inside a span', () => {
    expect(splitHighlightedLines('<span class="s">a\n\nb</span>')).toEqual([
      '<span class="s">a</span>',
      '<span class="s"></span>',
      '<span class="s">b</span>'
    ]);
  });
});

describe('highlightBlock', () => {
  it('returns exactly one entry per input line', () => {
    expect(highlightBlock('a = 1\nb = 2\nc = 3', 'x.py')).toHaveLength(3);
    expect(highlightBlock('', 'x.py')).toHaveLength(1);
  });

  it('carries multi-line string state across lines', () => {
    // The behaviour the per-line highlighter could not provide: line two is
    // inside the triple-quoted string and must be coloured as one.
    const lines = highlightBlock('x = """start\nstill inside\nend"""', 'x.py');
    expect(lines[1]).toContain('hljs-string');
  });

  it('escapes an unknown language instead of emitting raw HTML', () => {
    const [line] = highlightBlock('<script>alert(1)</script>', 'notes.unknownext');
    expect(line).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes markup inside a known language too', () => {
    const lines = highlightBlock('x = "<img onerror=y>"', 'x.py');
    expect(lines.join('')).not.toContain('<img');
    expect(lines.join('')).toContain('&lt;img');
  });
});

describe('escapeHtml', () => {
  it('neutralises the three characters that can open a tag', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href="x"&gt;&amp;&lt;/a&gt;');
  });

  it('escapes the ampersand first, so entities are not double-decoded', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});
