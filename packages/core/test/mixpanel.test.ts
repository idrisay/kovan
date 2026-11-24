import { describe, expect, it } from 'vitest';
import {
  discussMaterial, formatChange, formatMetric, groupMixpanelReports, headline, lastPeriodOpen, mixpanelHost,
  mixpanelReportUrl, parseInsightsResult, parseMixpanelDashboards, parseMixpanelQuery, parseMixpanelRegion,
  parseMixpanelReportRef, parseMixpanelReports, parseSegmentationResult, segmentationParams,
  type MixpanelReport
} from '../src/mixpanel';

const today = '2026-11-19';

describe('hosts and links', () => {
  it('maps each region to its host', () => {
    expect(mixpanelHost('us')).toBe('https://mixpanel.com');
    expect(mixpanelHost('eu')).toBe('https://eu.mixpanel.com');
    expect(parseMixpanelRegion(' EU ')).toBe('eu');
    expect(parseMixpanelRegion('mars')).toBeUndefined();
  });

  it('builds the web link Mixpanel itself uses', () => {
    expect(mixpanelReportUrl('eu', '2729535', { id: 93889668, type: 'insights' }))
      .toBe('https://eu.mixpanel.com/project/2729535/app/insights/#report/93889668');
    expect(mixpanelReportUrl('us', '1', { id: 5, type: 'funnels' })).toBe('https://mixpanel.com/project/1/app/funnels/#view/5');
  });

  it('reads a pasted report link or a bare id', () => {
    expect(parseMixpanelReportRef('https://eu.mixpanel.com/project/2729535/app/insights/#report/93889668'))
      .toEqual({ id: 93889668, type: 'insights' });
    expect(parseMixpanelReportRef('https://eu.mixpanel.com/project/2729535/view/3265619/app/insights#report/85798023'))
      .toEqual({ id: 85798023, type: 'insights' });
    expect(parseMixpanelReportRef('https://eu.mixpanel.com/project/1/app/funnels/#view/32393967')).toEqual({ id: 32393967, type: 'funnels' });
    expect(parseMixpanelReportRef(' 42 ')).toEqual({ id: 42, type: 'insights' });
    expect(parseMixpanelReportRef('https://example.com')).toBeUndefined();
  });
});

describe('report list', () => {
  it('reads every shape the App API has used, skipping rows with no name', () => {
    const boards = parseMixpanelDashboards({ results: [{ id: 7, title: 'B2School KPIs' }] });
    const rows = [
      { id: 1, name: 'Weekly Active Learners Trend (3m)', type: 'insights', dashboard_id: 7, creator_name: 'Gidy' },
      { id: 2, name: '', type: 'insights' },
      { id: 3, name: 'Signup funnel', type: 'funnel' }
    ];
    for (const body of [rows, { results: rows }, { results: Object.fromEntries(rows.map((r) => [r.id, r])) }]) {
      const reports = parseMixpanelReports(body, boards);
      expect(reports.map((r) => r.id)).toEqual([1, 3]);
      expect(reports[0]).toMatchObject({ dashboard: { id: 7, title: 'B2School KPIs' }, creator: 'Gidy' });
      expect(reports[1]!.type).toBe('funnels');
    }
  });

  it('groups pinned first, then dashboards A–Z, then the rest, and filters by every word', () => {
    const r = (id: number, name: string, board?: string): MixpanelReport =>
      ({ id, name, type: 'insights', ...(board ? { dashboard: { id: 1, title: board } } : {}) });
    const reports = [r(1, 'MAU', 'KPIs'), r(2, 'Seat utilization', 'KPIs'), r(3, 'Errors', 'Health'), r(4, 'Loose')];
    expect(groupMixpanelReports(reports, [2]).map((g) => [g.title, g.reports.map((x) => x.id)])).toEqual([
      ['Pinned', [2]], ['Health', [3]], ['KPIs', [1]], ['Other reports', [4]]
    ]);
    expect(groupMixpanelReports(reports, [], 'kpis seat').flatMap((g) => g.reports.map((x) => x.id))).toEqual([2]);
  });
});

describe('insights results', () => {
  it('reads a plain time series and sorts it by date', () => {
    const result = parseInsightsResult(9, {
      series: { 'B2School – Active Learners': { '2026-11-16T00:00:00+01:00': 245, '2026-11-09T00:00:00+01:00': 327 } },
      date_range: { from_date: '2026-08-17T00:00:00+02:00', to_date: '2026-11-19T00:00:00+01:00' }
    }, 1);
    expect(result.overTime).toBe(true);
    expect(result.series[0]!.points).toEqual([{ label: '2026-11-09', value: 327 }, { label: '2026-11-16', value: 245 }]);
    expect(result).toMatchObject({ from: '2026-08-17', to: '2026-11-19' });
  });

  it('puts $overall first and the biggest segments after it', () => {
    const result = parseInsightsResult(9, {
      series: { Learners: { $overall: { '2026-11-09': 30 }, 'School A': { '2026-11-09': 5 }, 'School B': { $overall: { '2026-11-09': 20 } } } }
    }, 1);
    expect(result.series.map((s) => s.name)).toEqual(['Learners', 'School B', 'School A']);
  });

  it('reads a single number', () => {
    const result = parseInsightsResult(9, { series: { 'WAU / MAU': { all: 0.49 } } }, 1);
    expect(result.overTime).toBe(false);
    expect(headline(result)).toEqual({ value: 0.49 });
  });

  it('gives the latest value and its change', () => {
    const result = parseInsightsResult(9, { series: { x: { '2026-10-01': 883, '2026-11-01': 1293 } } }, 1);
    const h = headline(result);
    expect(h.value).toBe(1293);
    expect(formatChange(h.change)).toBe('+46%');
    expect(formatChange(-0.25)).toBe('−25%');
    expect(formatMetric(1293)).toBe('1,293');
    expect(formatMetric(0.49)).toBe('0.49');
  });

  it('knows when the last period is still running', () => {
    const weeks = [{ label: '2026-11-09', value: 1 }, { label: '2026-11-16', value: 1 }];
    expect(lastPeriodOpen(weeks, today)).toBe(true);
    expect(lastPeriodOpen(weeks, '2026-11-24')).toBe(false);
  });

  it('reads segmentation answers', () => {
    const series = parseSegmentationResult({ data: { series: ['2026-11-09'], values: { A: { '2026-11-09': 1 }, B: { '2026-11-09': 9 } } } });
    expect(series.map((s) => s.name)).toEqual(['B', 'A']);
  });
});

describe('Discuss queries', () => {
  const ask = (json: string) => parseMixpanelQuery(`Let me check.\n\`\`\`mixpanel-query\n${json}\n\`\`\``, today);

  it('reads a well-formed query', () => {
    expect(ask('{"event":"Start Learning","type":"unique","unit":"week","from":"2026-10-12","to":"2026-11-19","by":"school_name"}').query)
      .toEqual({ event: 'Start Learning', type: 'unique', unit: 'week', from: '2026-10-12', to: '2026-11-19', by: 'school_name' });
  });

  it('is empty when the reply has no query', () => {
    expect(parseMixpanelQuery('The dip is the autumn break.', today)).toEqual({});
  });

  it('refuses bad dates, the future, too long a span and odd property names', () => {
    expect(ask('{"event":"x","from":"12.10.2026","to":"2026-11-19"}').error).toMatch(/YYYY-MM-DD/);
    expect(ask('{"event":"x","from":"2026-11-01","to":"2026-12-01"}').error).toMatch(/future/);
    expect(ask('{"event":"x","from":"2024-01-01","to":"2026-11-01"}').error).toMatch(/year/);
    expect(ask('{"event":"x","from":"2026-11-01","to":"2026-11-02","by":"a\\"] or 1"}').error).toMatch(/property/);
    expect(ask('not json').error).toMatch(/JSON/);
  });

  it('builds Mixpanel expressions itself, quoting values', () => {
    const { query } = ask('{"event":"Start Learning","from":"2026-11-01","to":"2026-11-02","by":"school_name","filters":[{"property":"user_type","equals":"Student \\"x\\""}]}');
    expect(segmentationParams(query!, '2729535')).toMatchObject({
      project_id: '2729535', on: 'properties["school_name"]', where: 'properties["user_type"] == "Student \\"x\\""'
    });
  });

  it('puts the report, the history and this turn\'s query results in the material', () => {
    const material = discussMaterial({
      report: { id: 1, name: 'Weekly Active Learners', type: 'insights' },
      result: parseInsightsResult(1, { series: { L: { '2026-10-05': 27 } } }, 1),
      events: ['Start Learning'],
      history: [{ role: 'you', text: 'Why the dip?', at: 1 }],
      question: 'Which schools grew?',
      runs: [{ query: { event: 'Start Learning', type: 'unique', unit: 'week', from: '2026-10-12', to: today }, error: 'HTTP 429' }],
      today
    });
    expect(material).toContain('2026-10-05\t27');
    expect(material).toContain('**User:** Why the dip?');
    expect(material).toContain('Which schools grew?');
    expect(material).toContain('Failed: HTTP 429');
  });
});
