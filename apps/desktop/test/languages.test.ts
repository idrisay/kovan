import { describe, expect, it } from 'vitest';
import { escapeHtml, highlightLines, languageFor } from '../src/renderer/languages';

describe('languageFor', () => {
  it('maps the extensions people actually open', () => {
    expect(languageFor('/a/b/main.py')).toBe('python');
    expect(languageFor('/a/b/App.tsx')).toBe('typescript');
    expect(languageFor('/a/b/index.mjs')).toBe('javascript');
    expect(languageFor('/a/b/Cargo.toml')).toBe('toml');
    expect(languageFor('/a/b/Prompts.swift')).toBe('swift');
    expect(languageFor('/a/b/style.scss')).toBe('css');
  });

  it('uses the last dot segment, not the first', () => {
    expect(languageFor('.eslintrc.json')).toBe('json');
    expect(languageFor('docker-compose.prod.yml')).toBe('yaml');
  });

  it('recognises files whose whole name is the signal', () => {
    expect(languageFor('/repo/Dockerfile')).toBe('dockerfile');
    expect(languageFor('/repo/Makefile')).toBe('shell');
    expect(languageFor('/repo/Gemfile')).toBe('ruby');
  });

  it('returns nothing for an unknown extension rather than guessing', () => {
    expect(languageFor('/a/b/data.bin')).toBeUndefined();
    expect(languageFor('/a/b/LICENSE')).toBeUndefined();
  });
});

describe('highlightLines', () => {
  it('returns exactly one entry per input line', () => {
    expect(highlightLines('a = 1\nb = 2\nc = 3', 'x.py')).toHaveLength(3);
    expect(highlightLines('', 'x.py')).toHaveLength(1);
  });

  it('carries multi-line string state across lines', () => {
    // The property a per-line highlighter cannot have: line two is inside the
    // triple-quoted string and has to be coloured as one.
    const lines = highlightLines('x = """start\nstill inside\nend"""', 'x.py');
    expect(lines[1]).toContain('tok-string');
  });

  it('colours a language that only a legacy stream mode covers', () => {
    const lines = highlightLines('let x = "hi"', 'A.swift');
    expect(lines[0]).toContain('tok-keyword');
  });

  it('escapes markup in a known language', () => {
    const html = highlightLines('x = "<img onerror=y>"', 'x.py').join('');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('escapes an unknown language instead of emitting raw HTML', () => {
    const [line] = highlightLines('<script>alert(1)</script>', 'notes.unknownext');
    expect(line).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('keeps every line independently balanced', () => {
    for (const line of highlightLines('def f():\n    """a\n    b"""\n    pass', 'x.py')) {
      const opens = line.match(/<span[^>]*>/g)?.length ?? 0;
      const closes = line.match(/<\/span>/g)?.length ?? 0;
      expect(opens).toBe(closes);
    }
  });

  it('preserves a blank line rather than dropping it', () => {
    expect(highlightLines('a = 1\n\nb = 2', 'x.py')).toHaveLength(3);
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
