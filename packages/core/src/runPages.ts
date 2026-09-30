/**
 * Which page "Open … in browser" opens for a run (item 109).
 *
 * It used to open the environment's base URL, which for a signed-in visitor
 * redirects to the dashboard — never the page the agent was checking. Agents
 * now write the page address next to each screenshot in `$KOVAN_PAGES`
 * ("02-lesson-page.png https://…"), so the button opens the page of the
 * screenshot you are looking at. Older runs have no such file; for them the
 * last address on the same site in the report is the best guess. Only pages
 * on the run's own site are ever chosen — anything else falls back to it.
 */

/** `pages.txt` → screenshot file name → URL. Later lines win. */
export function parseRunPages(text: string): Map<string, string> {
  const pages = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^\s*(\S+)\s+(https?:\/\/\S+)\s*$/.exec(line);
    if (match) pages.set(match[1]!.split('/').pop()!, match[2]!);
  }
  return pages;
}

function sameSite(url: string, site: string): boolean {
  try {
    return new URL(url).host === new URL(site).host;
  } catch {
    return false;
  }
}

export function runPageUrl(options: {
  site: string;
  /** Contents of the run's pages.txt, if any. */
  pages?: string;
  /** Contents of report.md, if any. */
  report?: string;
  /** The screenshot being looked at, by file name. */
  shot?: string;
}): string {
  const { site } = options;
  const pages = parseRunPages(options.pages ?? '');
  const onSite = (url: string | undefined) => (url && sameSite(url, site) ? url : undefined);
  const forShot = options.shot ? onSite(pages.get(options.shot.split('/').pop()!)) : undefined;
  if (forShot) return forShot;
  const lastRecorded = onSite([...pages.values()].pop());
  if (lastRecorded) return lastRecorded;
  // Older runs: the addresses the report mentions — full ones on this site,
  // and page paths ("/course/215/unit/1617?mode=preview") joined to
  // it. With a screenshot on screen, the one sharing its numbered words
  // ("unit-1617" ↔ "unit/1617") wins; otherwise the last mentioned.
  const candidates = reportPages(options.report ?? '', site);
  if (options.shot) {
    // "unit-1617" ↔ "unit/1617" counts double; a bare id of three or more
    // digits ("preview-524") matches it as a path segment ("/524").
    const pairs = [...options.shot.matchAll(/([a-z]+)-(\d+)/gi)].map((m) => `${m[1]!.toLowerCase()}/${m[2]}`);
    const ids = [...options.shot.matchAll(/(?:^|-)(\d{3,})(?=-|\.|$)/g)].map((m) => m[1]!);
    const score = (url: string) => {
      const lower = url.toLowerCase().split('?')[0]!;
      return pairs.filter((k) => lower.includes(k)).length * 2 + ids.filter((id) => new RegExp(`/${id}(/|$)`).test(lower)).length;
    };
    const scored = candidates
      .map((url, i) => ({ url, i, hits: score(url) }))
      .filter((c) => c.hits > 0)
      .sort((x, y) => y.hits - x.hits || y.i - x.i);
    if (scored[0]) return scored[0].url;
  }
  return candidates.pop() ?? site;
}

const FILE_EXTENSION = /\.(tsx?|jsx?|php|md|png|jpe?g|json|css|scss|vue|py|rb|go|rs|sh|ya?ml|lock|log)$/i;

/** Page addresses a report mentions, in order: absolute ones on `site`,
 *  and root-relative paths resolved against it. File paths are skipped. */
function reportPages(report: string, site: string): string[] {
  const base = new URL(site);
  const prefix = base.pathname.replace(/\/$/, '');
  const out: string[] = [];
  const pattern = /https?:\/\/[^\s)<>"'`\]]+|(?<![\w.:/~-])\/[a-z][\w-]*(?:\/[\w.%-]+)*(?:\?[\w=&%.-]*)?/g;
  for (const match of report.matchAll(pattern)) {
    const raw = match[0].replace(/[.,;:!?]+$/, '');
    if (/^https?:/i.test(raw)) {
      if (sameSite(raw, site)) out.push(raw);
      continue;
    }
    const pathOnly = raw.split('?')[0]!;
    if (FILE_EXTENSION.test(pathOnly) || /^\/(users|private|tmp|var|opt|home|src|app|apps|packages|node_modules)\//i.test(raw)) continue;
    const joined = prefix && raw.startsWith(`${prefix}/`) ? raw : `${prefix}${raw}`;
    out.push(`${base.origin}${joined}`);
  }
  return out;
}
