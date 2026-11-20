/**
 * Mixpanel in Kovan (item 177): the pure half. Hosts and links, turning the
 * Query API's answers into series, grouping the report list, and the small
 * query language the Discuss panel's model may ask Kovan to run.
 *
 * Kovan only reads Mixpanel. Nothing here writes to it, and nothing about
 * Kovan itself is sent there (that was item 105, a different question).
 */

export type MixpanelRegion = 'us' | 'eu' | 'in';

export const MIXPANEL_REGIONS: readonly MixpanelRegion[] = ['us', 'eu', 'in'];

/** "EU", "eu ", "Europe" → 'eu'; anything else is not a region. */
export function parseMixpanelRegion(value: string | undefined): MixpanelRegion | undefined {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'us' || v === 'usa' || v === 'united states') return 'us';
  if (v === 'eu' || v === 'europe') return 'eu';
  if (v === 'in' || v === 'india') return 'in';
  return undefined;
}

/** The one host per region that serves the web app, the Query API and the App API. */
export function mixpanelHost(region: MixpanelRegion): string {
  return region === 'us' ? 'https://mixpanel.com' : `https://${region}.mixpanel.com`;
}

export type MixpanelReportType = 'insights' | 'funnels' | 'retention' | 'flows' | 'other';

export interface MixpanelReport {
  id: number;
  name: string;
  type: MixpanelReportType;
  description?: string;
  creator?: string;
  /** ISO time of the last edit. */
  modified?: string;
  dashboard?: { id: number; title: string };
}

/** Where a report opens in Mixpanel's own web app. */
export function mixpanelReportUrl(region: MixpanelRegion, projectId: string, report: Pick<MixpanelReport, 'id' | 'type'>): string {
  const base = `${mixpanelHost(region)}/project/${encodeURIComponent(projectId)}/app`;
  switch (report.type) {
    case 'funnels': return `${base}/funnels/#view/${report.id}`;
    case 'flows': return `${base}/flows/#view/${report.id}`;
    case 'retention': return `${base}/retention/#report/${report.id}`;
    default: return `${base}/insights/#report/${report.id}`;
  }
}

/**
 * A report pasted by its link or typed by its number, for "Add a report".
 * Takes `…/app/insights#report/93889668`, `…/funnels/#view/123`, a bare id.
 */
export function parseMixpanelReportRef(text: string): { id: number; type: MixpanelReportType } | undefined {
  const t = text.trim();
  if (/^\d{1,12}$/.test(t)) return { id: Number(t), type: 'insights' };
  const m = /\/app\/(insights|funnels|retention|flows)\/?#(?:report|view)\/(\d{1,12})/.exec(t);
  if (!m) return undefined;
  return { id: Number(m[2]), type: m[1] as MixpanelReportType };
}

function reportType(raw: unknown): MixpanelReportType {
  const t = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (t === 'insights' || t === 'funnels' || t === 'retention' || t === 'flows') return t;
  if (t === 'funnel') return 'funnels';
  if (t === 'flow') return 'flows';
  return 'other';
}

/**
 * The App API's report list. Its shape has moved between versions (a bare
 * array, `{results: […]}`, `{results: {id: …}}`), so all three are read, and
 * a row without an id and a name is skipped rather than shown empty.
 */
export function parseMixpanelReports(json: unknown, dashboards: Map<number, string> = new Map()): MixpanelReport[] {
  const body = json as { results?: unknown } | unknown[] | null;
  const raw = Array.isArray(body) ? body : body && typeof body === 'object' ? (body as { results?: unknown }).results : undefined;
  const rows: unknown[] = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : [];
  const out: MixpanelReport[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = Number(r['id']);
    const name = typeof r['name'] === 'string' ? r['name'].trim() : '';
    if (!Number.isFinite(id) || !name) continue;
    const dashId = Number(r['dashboard_id'] ?? (r['dashboard'] as { id?: unknown } | undefined)?.id);
    const creator = r['creator_name'] ?? (r['creator'] as { name?: unknown } | undefined)?.name;
    out.push({
      id,
      name,
      type: reportType(r['type']),
      ...(typeof r['description'] === 'string' && r['description'] ? { description: r['description'] } : {}),
      ...(typeof creator === 'string' && creator ? { creator } : {}),
      ...(typeof r['modified'] === 'string' ? { modified: r['modified'] } : {}),
      ...(Number.isFinite(dashId) && dashboards.has(dashId) ? { dashboard: { id: dashId, title: dashboards.get(dashId)! } } : {})
    });
  }
  return out;
}

/** The App API's dashboard list, as id → title. */
export function parseMixpanelDashboards(json: unknown): Map<number, string> {
  const body = json as { results?: unknown } | unknown[] | null;
  const raw = Array.isArray(body) ? body : body && typeof body === 'object' ? (body as { results?: unknown }).results : undefined;
  const rows: unknown[] = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : [];
  const map = new Map<number, string>();
  for (const row of rows) {
    const r = row as Record<string, unknown> | null;
    const id = Number(r?.['id']);
    const title = r?.['title'] ?? r?.['name'];
    if (Number.isFinite(id) && typeof title === 'string' && title.trim()) map.set(id, title.trim());
  }
  return map;
}

export interface MixpanelPoint {
  /** `YYYY-MM-DD` for a time series, else the category's own label. */
  label: string;
  value: number;
}

export interface MixpanelSeries {
  name: string;
  points: MixpanelPoint[];
}

export interface MixpanelResult {
  reportId: number;
  /** The first series is the headline; the rest are its breakdown, biggest first. */
  series: MixpanelSeries[];
  /** True when the labels are dates, so it draws as a line over time. */
  overTime: boolean;
  /** Epoch ms Kovan asked. */
  fetchedAt: number;
  from?: string;
  to?: string;
}

const DATE_KEY = /^(\d{4}-\d{2}-\d{2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function isLeaf(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const values = Object.values(value);
  return values.length > 0 && values.every((v) => typeof v === 'number' || v === null);
}

function leafPoints(leaf: Record<string, number | null>): { points: MixpanelPoint[]; dated: boolean } {
  const entries = Object.entries(leaf);
  const dated = entries.every(([k]) => DATE_KEY.test(k));
  const points = entries.map(([k, v]) => ({ label: dated ? DATE_KEY.exec(k)![1]! : k, value: Number(v ?? 0) }));
  if (dated) points.sort((a, b) => a.label.localeCompare(b.label));
  return { points, dated };
}

/** How many breakdown segments are kept: past this a chart is noise. */
export const MIXPANEL_SEGMENT_LIMIT = 8;

/**
 * The Query API's insights answer (`/api/query/insights?bookmark_id=`) into
 * series. `series` maps each metric to either its points (`{date: n}` or
 * `{"all": n}` for a single number) or to its breakdown, where `$overall` is
 * the total and every other key a segment, possibly nested again.
 */
export function parseInsightsResult(reportId: number, json: unknown, fetchedAt: number): MixpanelResult {
  const body = (json ?? {}) as { series?: unknown; date_range?: { from_date?: string; to_date?: string } };
  const series: MixpanelSeries[] = [];
  let overTime = false;
  const segments: MixpanelSeries[] = [];
  const raw = body.series && typeof body.series === 'object' ? (body.series as Record<string, unknown>) : {};
  for (const [metric, value] of Object.entries(raw)) {
    if (isLeaf(value)) {
      const { points, dated } = leafPoints(value);
      overTime ||= dated;
      series.push({ name: metric, points });
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    const groups = value as Record<string, unknown>;
    const overall = groups['$overall'];
    if (isLeaf(overall)) {
      const { points, dated } = leafPoints(overall);
      overTime ||= dated;
      series.push({ name: metric, points });
    }
    for (const [segment, inner] of Object.entries(groups)) {
      if (segment === '$overall') continue;
      // One more level: a breakdown's segment can itself hold `$overall`.
      const leaf = isLeaf(inner) ? inner : isLeaf((inner as Record<string, unknown> | null)?.['$overall']) ? (inner as Record<string, Record<string, number>>)['$overall'] : undefined;
      if (!leaf) continue;
      const { points, dated } = leafPoints(leaf);
      overTime ||= dated;
      segments.push({ name: segment, points });
    }
  }
  const total = (s: MixpanelSeries) => s.points.reduce((sum, p) => sum + p.value, 0);
  segments.sort((a, b) => total(b) - total(a));
  // With no `$overall`, the biggest segment leads; that is what Mixpanel shows first too.
  const all = [...series, ...segments.slice(0, MIXPANEL_SEGMENT_LIMIT)];
  return {
    reportId,
    series: all,
    overTime,
    fetchedAt,
    ...(body.date_range?.from_date ? { from: body.date_range.from_date.slice(0, 10) } : {}),
    ...(body.date_range?.to_date ? { to: body.date_range.to_date.slice(0, 10) } : {})
  };
}

/** The segmentation endpoint's `{data: {values: {name: {date: n}}}}`, as series. */
export function parseSegmentationResult(json: unknown): MixpanelSeries[] {
  const values = (json as { data?: { values?: Record<string, unknown> } } | null)?.data?.values ?? {};
  const out: MixpanelSeries[] = [];
  for (const [name, leaf] of Object.entries(values)) {
    if (isLeaf(leaf)) out.push({ name, points: leafPoints(leaf).points });
  }
  const total = (s: MixpanelSeries) => s.points.reduce((sum, p) => sum + p.value, 0);
  return out.sort((a, b) => total(b) - total(a)).slice(0, MIXPANEL_SEGMENT_LIMIT * 2);
}

/** The latest value and its change from the one before, for a sidebar row. */
export function headline(result: MixpanelResult | undefined): { value?: number; change?: number } {
  const points = result?.series[0]?.points ?? [];
  const last = points[points.length - 1];
  if (!last) return {};
  if (!result?.overTime || points.length < 2) return { value: last.value };
  const before = points[points.length - 2]!.value;
  return { value: last.value, ...(before > 0 ? { change: (last.value - before) / before } : {}) };
}

/**
 * Whether the last point's period is still running, so the chart draws it
 * dashed, as Mixpanel does. `unit` is guessed from the spacing of the points.
 */
export function lastPeriodOpen(points: MixpanelPoint[], today: string): boolean {
  if (points.length < 2) return false;
  const last = points[points.length - 1]!.label;
  const prev = points[points.length - 2]!.label;
  const step = (Date.parse(last) - Date.parse(prev)) / 86_400_000;
  if (!Number.isFinite(step) || step <= 0) return false;
  const end = Date.parse(last) + step * 86_400_000;
  return Date.parse(today) < end;
}

/** 1293 → "1,293", 0.49 → "0.49", 0.234 → "0.23". Never more than two decimals. */
export function formatMetric(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  if (Number.isInteger(value)) return value.toLocaleString('en-US');
  return value.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: Math.abs(value) < 1 ? 2 : 0 });
}

/** +0.46 → "+46%", −0.25 → "−25%". */
export function formatChange(change: number | undefined): string {
  if (change === undefined || !Number.isFinite(change)) return '';
  const pct = Math.round(change * 100);
  return `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct)}%`;
}

export interface MixpanelGroup {
  title: string;
  reports: MixpanelReport[];
}

/**
 * The sidebar's groups: pinned first, in pin order, then one group per
 * dashboard (A–Z), then reports on no dashboard. A filter matches every word,
 * in any order, against the name and the dashboard.
 */
export function groupMixpanelReports(reports: MixpanelReport[], pins: number[], filter = ''): MixpanelGroup[] {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (r: MixpanelReport) => {
    const hay = `${r.name} ${r.dashboard?.title ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  const shown = reports.filter(matches);
  const byId = new Map(shown.map((r) => [r.id, r]));
  const pinned = pins.map((id) => byId.get(id)).filter((r): r is MixpanelReport => Boolean(r));
  const groups: MixpanelGroup[] = pinned.length ? [{ title: 'Pinned', reports: pinned }] : [];
  const boards = new Map<string, MixpanelReport[]>();
  const loose: MixpanelReport[] = [];
  for (const r of shown) {
    if (pins.includes(r.id)) continue;
    if (r.dashboard) boards.set(r.dashboard.title, [...(boards.get(r.dashboard.title) ?? []), r]);
    else loose.push(r);
  }
  for (const title of [...boards.keys()].sort((a, b) => a.localeCompare(b))) {
    groups.push({ title, reports: boards.get(title)!.sort((a, b) => a.name.localeCompare(b.name)) });
  }
  if (loose.length) groups.push({ title: boards.size ? 'Other reports' : 'Reports', reports: loose.sort((a, b) => a.name.localeCompare(b.name)) });
  return groups;
}

// --- Discuss -------------------------------------------------------------

/**
 * A question the Discuss model may ask Kovan to run, as JSON in a fenced
 * `mixpanel-query` block. Deliberately small: an event, how to count it,
 * a period, at most one breakdown property and a few equality filters.
 * Kovan builds Mixpanel's own expression strings from these itself, so a
 * model never writes one.
 */
export interface MixpanelQuery {
  event: string;
  type: 'unique' | 'general';
  unit: 'day' | 'week' | 'month';
  from: string;
  to: string;
  by?: string;
  filters?: { property: string; equals: string }[];
}

/** At most this many extra queries per question: the Query API allows 60 an hour. */
export const MIXPANEL_QUERIES_PER_QUESTION = 2;

const PROPERTY = /^[\w$][\w $.\-]{0,79}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The first `mixpanel-query` block in a model's reply, checked; or why it was refused. */
export function parseMixpanelQuery(text: string, today: string): { query?: MixpanelQuery; error?: string } {
  const block = /```mixpanel-query\s*\n([\s\S]*?)```/.exec(text);
  if (!block) return {};
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(block[1]!) as Record<string, unknown>;
  } catch {
    return { error: 'The query was not valid JSON.' };
  }
  const event = typeof raw['event'] === 'string' ? raw['event'].trim() : '';
  if (!event || event.length > 200) return { error: 'The query names no event.' };
  const type = raw['type'] === 'general' ? 'general' : 'unique';
  const unit = raw['unit'] === 'day' || raw['unit'] === 'month' ? raw['unit'] : 'week';
  const from = String(raw['from'] ?? '');
  const to = String(raw['to'] ?? today);
  if (!DAY.test(from) || !DAY.test(to) || from > to) return { error: 'The query needs from and to as YYYY-MM-DD, from first.' };
  if (to > today) return { error: 'The query ends in the future.' };
  if (Date.parse(to) - Date.parse(from) > 366 * 86_400_000) return { error: 'The query spans more than a year.' };
  const by = typeof raw['by'] === 'string' && raw['by'].trim() ? raw['by'].trim() : undefined;
  if (by && !PROPERTY.test(by)) return { error: `"${by}" is not a property name.` };
  const filters: { property: string; equals: string }[] = [];
  if (Array.isArray(raw['filters'])) {
    for (const f of raw['filters'].slice(0, 4)) {
      const property = typeof f?.property === 'string' ? f.property.trim() : '';
      const equals = typeof f?.equals === 'string' ? f.equals : '';
      if (!PROPERTY.test(property) || equals.length > 200) return { error: 'A filter needs a property name and a value.' };
      filters.push({ property, equals });
    }
  }
  return { query: { event, type, unit, from, to, ...(by ? { by } : {}), ...(filters.length ? { filters } : {}) } };
}

/** The segmentation endpoint's parameters for a checked query. JSON quoting does Mixpanel's escaping. */
export function segmentationParams(query: MixpanelQuery, projectId: string): Record<string, string> {
  const prop = (name: string) => `properties[${JSON.stringify(name)}]`;
  return {
    project_id: projectId,
    event: query.event,
    type: query.type,
    unit: query.unit,
    from_date: query.from,
    to_date: query.to,
    ...(query.by ? { on: prop(query.by) } : {}),
    ...(query.filters?.length
      ? { where: query.filters.map((f) => `${prop(f.property)} == ${JSON.stringify(f.equals)}`).join(' and ') }
      : {})
  };
}

/** One line a person can read back: what was asked of Mixpanel. */
export function describeMixpanelQuery(q: MixpanelQuery): string {
  const parts = [`${q.type === 'unique' ? 'unique users of' : 'count of'} ${q.event}`, `per ${q.unit}`, `${q.from} → ${q.to}`];
  if (q.by) parts.push(`by ${q.by}`);
  for (const f of q.filters ?? []) parts.push(`where ${f.property} = ${f.equals}`);
  return parts.join(' · ');
}

export interface DiscussQueryRun {
  query: MixpanelQuery;
  series?: MixpanelSeries[];
  error?: string;
}

export interface DiscussMessage {
  role: 'you' | 'model';
  text: string;
  at: number;
  model?: string;
  /** Extra queries the model asked for while answering, with what came back. */
  queries?: DiscussQueryRun[];
}

function seriesTable(series: MixpanelSeries[], limit = 60): string {
  return series
    .map((s) => `### ${s.name}\n${s.points.slice(-limit).map((p) => `${p.label}\t${p.value}`).join('\n')}`)
    .join('\n\n');
}

/**
 * What the model reads: the report, its numbers, the event names it may
 * query, the conversation so far and any query results from this turn.
 * Goes in an attached file, like every quick-model input.
 */
export function discussMaterial(input: {
  report: MixpanelReport;
  result?: MixpanelResult;
  events: string[];
  history: DiscussMessage[];
  question: string;
  runs: DiscussQueryRun[];
  today: string;
  notes?: string[];
}): string {
  const { report, result } = input;
  const lines = [
    `# Mixpanel report: ${report.name}`,
    `Type: ${report.type}${report.dashboard ? ` · dashboard: ${report.dashboard.title}` : ''}${report.creator ? ` · by ${report.creator}` : ''}`,
    report.description ? `Description: ${report.description}` : '',
    `Today: ${input.today}`,
    result?.from ? `Period shown: ${result.from} → ${result.to ?? input.today}` : '',
    '',
    '## Its data',
    result && result.series.length ? seriesTable(result.series) : '(not loaded)',
    ''
  ];
  if (input.notes?.length) lines.push('## Notes saved on this report', ...input.notes.map((n) => `- ${n}`), '');
  if (input.events.length) lines.push('## Event names you may query', input.events.slice(0, 80).join(', '), '');
  if (input.history.length) {
    lines.push('## Conversation so far');
    for (const m of input.history.slice(-10)) lines.push(`**${m.role === 'you' ? 'User' : 'You'}:** ${m.text}`, '');
  }
  lines.push('## The question now', input.question, '');
  if (input.runs.length) {
    lines.push('## Queries Kovan ran for you this turn');
    for (const run of input.runs) {
      lines.push(`- ${describeMixpanelQuery(run.query)}`);
      lines.push(run.error ? `  Failed: ${run.error}` : seriesTable(run.series ?? [], 40));
    }
  }
  return lines.filter((l, i, all) => !(l === '' && all[i - 1] === '')).join('\n');
}

export function discussInstruction(queriesLeft: number): string {
  return [
    'You help a team discuss the Mixpanel report in the attached file.',
    'Answer the question under "The question now" from the data given. Be short and concrete: name the weeks, numbers and changes you mean.',
    'Say when the data cannot answer it. Never invent numbers.',
    queriesLeft > 0
      ? 'If you need data the file does not have, reply with ONLY one fenced block, nothing else:\n' +
        '```mixpanel-query\n{"event": "<an event name from the list>", "type": "unique" or "general", "unit": "day" | "week" | "month", "from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "by": "<optional property to split by>", "filters": [{"property": "<name>", "equals": "<value>"}]}\n```\n' +
        'Kovan runs it read-only and asks you again with the result.'
      : 'Do not ask for more queries; answer with what you have.',
    'Plain text, no headings. At most 8 short lines.'
  ].join('\n');
}
