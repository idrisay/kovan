import type { CancelSignal } from '@kovan/host';
import {
  mixpanelHost, parseInsightsResult, parseMixpanelDashboards, parseMixpanelReports, parseSegmentationResult,
  segmentationParams, type MixpanelQuery, type MixpanelRegion, type MixpanelReport, type MixpanelResult,
  type MixpanelSeries
} from '@kovan/core';
import type { HttpClient } from '../http';

/**
 * Mixpanel, read only (item 177), with a service account: a username and a
 * secret sent as Basic auth, which both the Query API and the App API take.
 * Every call is a GET. The Query API allows 60 queries an hour per project,
 * which is why the main process caches what this returns.
 */
export class MixpanelClient {
  constructor(
    private readonly http: HttpClient,
    private readonly region: MixpanelRegion,
    private readonly projectId: string,
    private readonly username: string,
    private readonly secret: string
  ) {}

  private get headers(): Record<string, string> {
    // btoa, not Buffer: this package is also built for the renderer.
    return { Authorization: `Basic ${btoa(`${this.username}:${this.secret}`)}`, Accept: 'application/json' };
  }

  private url(path: string, params: Record<string, string> = {}): string {
    const query = new URLSearchParams(params).toString();
    return `${mixpanelHost(this.region)}${path}${query ? `?${query}` : ''}`;
  }

  private get project(): string {
    return encodeURIComponent(this.projectId);
  }

  /** The project's name, which also proves the account can read it. */
  async verify(signal?: CancelSignal): Promise<string> {
    const body = await this.http.json<{ results?: { name?: string } }>(
      this.url(`/api/app/projects/${this.project}`), { headers: this.headers, signal }
    );
    return body?.results?.name ?? `project ${this.projectId}`;
  }

  /**
   * Every saved report, each with its dashboard's title when Mixpanel says
   * which one it is on. A failing dashboard list only loses the grouping.
   */
  async listReports(signal?: CancelSignal): Promise<MixpanelReport[]> {
    const dashboards = await this.http
      .json<unknown>(this.url(`/api/app/projects/${this.project}/dashboards`), { headers: this.headers, signal })
      .then(parseMixpanelDashboards)
      .catch(() => new Map<number, string>());
    const reports = await this.http.json<unknown>(
      this.url(`/api/app/projects/${this.project}/bookmarks`, { v: '2' }), { headers: this.headers, signal }
    );
    return parseMixpanelReports(reports, dashboards);
  }

  /** A saved insights report's numbers, as Mixpanel computes them for its own chart. */
  async insights(reportId: number, signal?: CancelSignal): Promise<MixpanelResult> {
    const body = await this.http.json<unknown>(
      this.url('/api/query/insights', { project_id: this.projectId, bookmark_id: String(reportId) }),
      { headers: this.headers, signal, timeoutMs: 60_000 }
    );
    return parseInsightsResult(reportId, body, Date.now());
  }

  /** One checked Discuss query (see `parseMixpanelQuery`). */
  async segmentation(query: MixpanelQuery, signal?: CancelSignal): Promise<MixpanelSeries[]> {
    const body = await this.http.json<unknown>(
      this.url('/api/query/segmentation', segmentationParams(query, this.projectId)),
      { headers: this.headers, signal, timeoutMs: 60_000 }
    );
    return parseSegmentationResult(body);
  }

  /** The project's most used event names, for the Discuss model to pick from. */
  async eventNames(signal?: CancelSignal): Promise<string[]> {
    const body = await this.http.json<unknown>(
      this.url('/api/query/events/names', { project_id: this.projectId, type: 'general', limit: '100' }),
      { headers: this.headers, signal }
    );
    return Array.isArray(body) ? body.filter((x): x is string => typeof x === 'string') : [];
  }
}
