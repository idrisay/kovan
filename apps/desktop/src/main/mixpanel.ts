/**
 * Mixpanel in Kovan (item 177): the main-process half.
 *
 * Nothing here runs on a timer and nothing is polled. The report list is
 * asked for once, the first time the Mixpanel tab opens with none kept, and
 * again only on its Reload button or new credentials. A report's numbers are
 * asked for when you pick it in the list, and reused for `FRESH_MS` unless
 * you press Refresh (Mixpanel's Query API allows 60 queries an hour per
 * project). Coming back to the tab asks for nothing. The model runs only
 * when you ask a question in Discuss.
 *
 * Kept on disk in `mixpanel/state.json`: the report list and the last
 * numbers per report (so the tab shows them after a restart without asking
 * again), the Discuss conversation per report and the notes saved from it.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  MIXPANEL_QUERIES_PER_QUESTION, QUICK_DEFAULT_MODEL, describeMixpanelQuery, discussInstruction, discussMaterial,
  parseMixpanelQuery, parseMixpanelRegion, parseMixpanelReportRef, parseReviewToolModel,
  type DiscussMessage, type DiscussQueryRun, type MixpanelRegion, type MixpanelReport, type MixpanelResult
} from '@kovan/core';
import { Credentials, HttpClient, MixpanelClient } from '@kovan/providers';
import type { DesktopHost } from './host';
import type { QuickModel } from './quick';
import type { ReviewTools } from './reviewTools';

/** How long a report's numbers count as fresh. */
const FRESH_MS = 15 * 60_000;

/** A smoke run on a throwaway profile: Mixpanel is a fixture, never the network. */
const SMOKE = Boolean(process.env['KOVAN_SMOKE'] && process.env['KOVAN_USER_DATA']);

/** How often a smoke run's fixture was asked, so it can tell a revisit asked nothing. */
export const mixpanelAsked = { list: 0, numbers: 0 };
const THREAD_LIMIT = 40;
const NOTES_LIMIT = 30;

export interface MixpanelStatus {
  connected: boolean;
  region?: MixpanelRegion;
  projectId?: string;
  /** What is wrong with the connection's settings, in words. */
  problem?: string;
  /** The Settings fields still empty, by their labels, while not connected. */
  missing?: string[];
}

/** Why Mixpanel refused, so the tab can say what to fix and where. */
export type MixpanelErrorKind = 'auth' | 'access' | 'notFound' | 'limit' | 'other';

export interface MixpanelReportList {
  reports: MixpanelReport[];
  /** Why the list could not be read; added reports are still listed. */
  error?: string;
  errorKind?: MixpanelErrorKind;
  at: number;
}

export interface MixpanelProgress {
  reportId: number;
  /** "Thinking", "Running a query: …", or undefined once done. */
  step?: string;
}

interface Saved {
  /** The last report list read from Mixpanel, without the reports added by link. */
  list?: MixpanelReportList;
  results: Record<string, MixpanelResult>;
  threads: Record<string, DiscussMessage[]>;
  notes: Record<string, string[]>;
}

export class MixpanelService {
  private readonly http: HttpClient;
  private readonly file: string;
  private saved: Saved = { results: {}, threads: {}, notes: {} };
  private readonly loaded: Promise<void>;
  private events?: { at: number; names: string[] };
  /** One question per report at a time. */
  private readonly asking = new Set<number>();
  private writing: Promise<void> = Promise.resolve();
  private progressListener?: (progress: MixpanelProgress) => void;

  constructor(
    private readonly host: DesktopHost,
    private readonly credentials: Credentials,
    private readonly quick: QuickModel,
    private readonly reviewTools: ReviewTools
  ) {
    this.http = new HttpClient(host.log);
    this.file = path.join(host.files.stateDir(), 'mixpanel', 'state.json');
    this.loaded = this.load();
    // New credentials mean another project, maybe: forget the list.
    credentials.onDidChange((id) => {
      if (id === 'mixpanel') {
        delete this.saved.list;
        this.events = undefined;
        void this.persist();
      }
    });
  }

  onProgress(listener: (progress: MixpanelProgress) => void): void {
    this.progressListener = listener;
  }

  private async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Partial<Saved>;
      this.saved = { results: raw.results ?? {}, threads: raw.threads ?? {}, notes: raw.notes ?? {}, ...(raw.list ? { list: raw.list } : {}) };
    } catch {
      // First run, or a damaged file: start empty rather than fail the tab.
    }
  }

  /** Writes run one after another, each with the latest state. */
  private persist(): Promise<void> {
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(path.dirname(this.file), { recursive: true });
        await writeFile(this.file, JSON.stringify(this.saved), 'utf8');
      } catch (err) {
        this.host.log.warn(`mixpanel: could not save state: ${String(err)}`);
      }
    });
    return this.writing;
  }

  private settings(): { region?: MixpanelRegion; projectId: string; username: string } {
    return {
      region: parseMixpanelRegion(this.host.config.get('mixpanel.region', '')),
      projectId: this.host.config.get('mixpanel.projectId', '').trim(),
      username: this.host.config.get('mixpanel.username', '').trim()
    };
  }

  async status(): Promise<MixpanelStatus> {
    const connected = await this.credentials.isConnected('mixpanel');
    const s = this.settings();
    if (!connected) return { connected: false, missing: await this.credentials.missingFields('mixpanel') };
    if (!s.region) return { connected: true, problem: 'The data region must be us, eu or in. Fix it in Settings › Connections › Mixpanel.' };
    if (!/^\d+$/.test(s.projectId)) return { connected: true, region: s.region, problem: 'The project ID must be a number, as in the address of a Mixpanel report.' };
    return { connected: true, region: s.region, projectId: s.projectId };
  }

  private async client(): Promise<MixpanelClient> {
    const status = await this.status();
    if (!status.connected) throw new Error('Mixpanel is not connected. Add a service account in Settings › Connections.');
    if (status.problem) throw new Error(status.problem);
    if (SMOKE) return smokeClient();
    const secret = await this.credentials.token('mixpanel');
    if (!secret) throw new Error('Mixpanel is not connected. Add a service account in Settings › Connections.');
    const s = this.settings();
    return new MixpanelClient(this.http, status.region!, status.projectId!, s.username, secret);
  }

  /** Reports added by link, shaped like listed ones. */
  private added(): MixpanelReport[] {
    return this.host.config.get<{ id: number; type: string; name?: string }[]>('mixpanel.added', []).map((a) => ({
      id: a.id,
      name: a.name || `Report ${a.id}`,
      type: (['insights', 'funnels', 'retention', 'flows'].includes(a.type) ? a.type : 'other') as MixpanelReport['type']
    }));
  }

  /**
   * The saved reports. The kept list is answered as it is, however old, unless
   * `force` (the Reload button) or the last try failed: opening the tab must
   * not ask Mixpanel again each time.
   */
  async reports(force = false): Promise<MixpanelReportList> {
    await this.loaded;
    const kept = this.saved.list;
    if (!force && kept && !kept.error) return this.withAdded(kept);
    let list: MixpanelReportList;
    try {
      list = { reports: await (await this.client()).listReports(), at: Date.now() };
    } catch (err) {
      list = {
        reports: kept?.reports ?? [], error: describeMixpanelError(err, 'list your reports'),
        errorKind: mixpanelErrorKind(err), at: Date.now()
      };
    }
    this.saved.list = list;
    void this.persist();
    return this.withAdded(list);
  }

  private withAdded(list: MixpanelReportList): MixpanelReportList {
    const known = new Set(list.reports.map((r) => r.id));
    return { ...list, reports: [...list.reports, ...this.added().filter((r) => !known.has(r.id))] };
  }

  /** Every report's last numbers, for the sidebar's values. Asks Mixpanel nothing. */
  async cached(): Promise<Record<string, MixpanelResult>> {
    await this.loaded;
    return this.saved.results;
  }

  async result(reportId: number, type: MixpanelReport['type'], force = false): Promise<MixpanelResult> {
    await this.loaded;
    const kept = this.saved.results[reportId];
    if (!force && kept && Date.now() - kept.fetchedAt < FRESH_MS) return kept;
    if (type !== 'insights' && type !== 'other') {
      throw new Error(`Kovan shows Insights reports for now. Open this ${type.replace(/s$/, '')} report in Mixpanel.`);
    }
    try {
      const fresh = await (await this.client()).insights(reportId);
      this.saved.results[reportId] = fresh;
      void this.persist();
      return fresh;
    } catch (err) {
      throw new Error(describeMixpanelError(err, 'load this report'));
    }
  }

  /** "Add a report" by its link or number. Checked by loading it once. */
  async add(ref: string, name?: string): Promise<MixpanelReport> {
    const parsed = parseMixpanelReportRef(ref);
    if (!parsed) throw new Error('Paste a Mixpanel report link (…/app/insights#report/123) or its number.');
    await this.result(parsed.id, parsed.type, true);
    const all = this.host.config.get<{ id: number; type: string; name?: string }[]>('mixpanel.added', []);
    const entry = { id: parsed.id, type: parsed.type, ...(name?.trim() ? { name: name.trim() } : {}) };
    await this.host.config.set('mixpanel.added', [...all.filter((a) => a.id !== parsed.id), entry]);
    return this.added().find((r) => r.id === parsed.id)!;
  }

  async removeAdded(reportId: number): Promise<void> {
    const all = this.host.config.get<{ id: number }[]>('mixpanel.added', []);
    await this.host.config.set('mixpanel.added', all.filter((a) => a.id !== reportId));
  }

  async thread(reportId: number): Promise<{ messages: DiscussMessage[]; notes: string[]; busy: boolean; model: string }> {
    await this.loaded;
    return {
      messages: this.saved.threads[reportId] ?? [],
      notes: this.saved.notes[reportId] ?? [],
      busy: this.asking.has(reportId),
      model: this.model()
    };
  }

  /**
   * What Discuss runs on: its own pick from the composer's model tag, else the
   * quick model. An opencode `provider/model`, or `sonnet (claude)` (see
   * `reviewToolModel`): one of your reviewers, or a Claude Code or Codex from
   * the Agents tab by its command (`ReviewTools.agentAsTool`).
   */
  model(): string {
    return this.host.config.get('mixpanel.discussModel', '') || this.host.config.get('quick.model', '') || QUICK_DEFAULT_MODEL;
  }

  async setModel(model: string): Promise<string> {
    const value = model.trim();
    if (value) await this.host.config.set('mixpanel.discussModel', value);
    return this.model();
  }

  /** One round of Discuss on whichever model is picked. */
  private async answer(model: string, material: string, instruction: string): Promise<{ text?: string; error?: string }> {
    const picked = parseReviewToolModel(model);
    if (!picked) return this.quick.askOnce(model, material, instruction);
    // A reviewer from Settings, or a Claude Code or Codex from the Agents tab.
    const tool = this.reviewTools.find(picked.id) ?? await this.reviewTools.agentAsTool(picked.id);
    if (!tool) throw new Error(`Kovan can't find ${picked.id} any more. Pick another model under the question box.`);
    // A reviewer reads one prompt on stdin rather than an attached file.
    const prompt = `${instruction}\n\n--- The attached file ---\n\n${material}`;
    return { text: await this.reviewTools.ask({ ...tool, model: picked.model }, prompt) };
  }

  async clearThread(reportId: number): Promise<void> {
    await this.loaded;
    delete this.saved.threads[reportId];
    await this.persist();
  }

  async addNote(reportId: number, text: string): Promise<string[]> {
    await this.loaded;
    const clean = text.trim();
    if (!clean) return this.saved.notes[reportId] ?? [];
    this.saved.notes[reportId] = [...(this.saved.notes[reportId] ?? []), clean].slice(-NOTES_LIMIT);
    await this.persist();
    return this.saved.notes[reportId]!;
  }

  async removeNote(reportId: number, index: number): Promise<string[]> {
    await this.loaded;
    const notes = [...(this.saved.notes[reportId] ?? [])];
    notes.splice(index, 1);
    this.saved.notes[reportId] = notes;
    await this.persist();
    return notes;
  }

  private async eventNames(client: MixpanelClient): Promise<string[]> {
    if (this.events && Date.now() - this.events.at < 60 * 60_000) return this.events.names;
    const names = await client.eventNames().catch(() => []);
    this.events = { at: Date.now(), names };
    return names;
  }

  /**
   * One question in Discuss. The model answers from the report's numbers; if
   * it needs more it replies with one `mixpanel-query` block, Kovan checks
   * and runs it (read-only segmentation) and asks again, at most
   * `MIXPANEL_QUERIES_PER_QUESTION` times. Only the final answer is kept,
   * with the queries that led to it.
   */
  async ask(report: MixpanelReport, question: string): Promise<DiscussMessage[]> {
    await this.loaded;
    const text = question.trim();
    if (!text) return this.saved.threads[report.id] ?? [];
    if (this.asking.has(report.id)) throw new Error('Still answering the last question about this report.');
    this.asking.add(report.id);
    const history = this.saved.threads[report.id] ?? [];
    const asked: DiscussMessage = { role: 'you', text, at: Date.now() };
    this.saved.threads[report.id] = [...history, asked].slice(-THREAD_LIMIT);
    const progress = (step?: string) => this.progressListener?.({ reportId: report.id, ...(step ? { step } : {}) });
    const model = this.model();
    try {
      const client = await this.client();
      const result = this.saved.results[report.id];
      const events = await this.eventNames(client);
      const today = new Date().toISOString().slice(0, 10);
      const runs: DiscussQueryRun[] = [];
      let answer = '';
      for (let round = 0; ; round++) {
        progress(round === 0 ? 'Thinking' : 'Reading the query result');
        const left = MIXPANEL_QUERIES_PER_QUESTION - runs.length;
        const material = discussMaterial({ report, result, events, history, question: text, runs, today, notes: this.saved.notes[report.id] });
        const out = await this.answer(model, material, discussInstruction(left));
        if (!out.text) throw new Error(out.error ?? 'The model returned no answer.');
        const { query, error } = parseMixpanelQuery(out.text, today);
        if ((!query && !error) || left <= 0) {
          answer = out.text.replace(/```mixpanel-query[\s\S]*?```/g, '').trim() || 'The model asked for more data than one question may use. Try a narrower question.';
          break;
        }
        if (error) {
          // Tell the model what was wrong once, as if the query had failed.
          runs.push({ query: { event: '?', type: 'unique', unit: 'week', from: today, to: today }, error });
          continue;
        }
        progress(`Running a query: ${describeMixpanelQuery(query!)}`);
        try {
          runs.push({ query: query!, series: await client.segmentation(query!) });
        } catch (err) {
          runs.push({ query: query!, error: describeMixpanelError(err, 'run that query') });
        }
      }
      const reply: DiscussMessage = { role: 'model', text: answer, at: Date.now(), model, ...(runs.length ? { queries: runs.filter((r) => r.query.event !== '?') } : {}) };
      this.saved.threads[report.id] = [...this.saved.threads[report.id]!, reply].slice(-THREAD_LIMIT);
    } catch (err) {
      // The question stays, with the failure as the answer, so it can be asked again.
      const reply: DiscussMessage = { role: 'model', text: `Could not answer: ${err instanceof Error ? err.message : String(err)}`, at: Date.now(), model };
      this.saved.threads[report.id] = [...this.saved.threads[report.id]!, reply].slice(-THREAD_LIMIT);
    } finally {
      this.asking.delete(report.id);
      progress();
      await this.persist();
    }
    return this.saved.threads[report.id]!;
  }
}

/** Two weekly Insights reports, counted, for the smoke run. */
function smokeClient(): MixpanelClient {
  const weeks = Array.from({ length: 8 }, (_, i) => new Date(Date.now() - (7 - i) * 7 * 86_400_000).toISOString().slice(0, 10));
  const fake: Pick<MixpanelClient, 'listReports' | 'insights' | 'eventNames' | 'segmentation'> = {
    listReports: async () => {
      mixpanelAsked.list++;
      return [
        { id: 101, name: 'Weekly signups', type: 'insights', dashboard: { id: 1, title: 'Growth' } },
        { id: 102, name: 'Lessons started', type: 'insights', dashboard: { id: 1, title: 'Growth' } }
      ];
    },
    insights: async (reportId: number) => {
      mixpanelAsked.numbers++;
      const points = weeks.map((label, i) => ({ label, value: 400 + i * 35 + (reportId % 7) * 10 }));
      return { reportId, series: [{ name: 'Sign up', points }], overTime: true, fetchedAt: Date.now() };
    },
    eventNames: async () => ['Sign up', 'Lesson started'],
    segmentation: async () => []
  };
  return fake as MixpanelClient;
}

export function mixpanelErrorKind(err: unknown): MixpanelErrorKind {
  const status = (err as { status?: number })?.status;
  if (status === 401) return 'auth';
  if (status === 403) return 'access';
  if (status === 404) return 'notFound';
  if (status === 429) return 'limit';
  return 'other';
}

/** Mixpanel's refusals, in words that say what to do. */
export function describeMixpanelError(err: unknown, doing: string): string {
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number })?.status;
  const body = String((err as { body?: string })?.body ?? '');
  if (status === 401) return `Mixpanel did not accept the service account, so Kovan could not ${doing}. Check the username and secret in Settings › Connections.`;
  if (status === 403) return `The service account may not read this project, so Kovan could not ${doing}. In Mixpanel, give it access to the project (Organization settings › Service accounts), or check the project ID in Settings › Connections.`;
  if (status === 404) return `Mixpanel did not find it, so Kovan could not ${doing}. Check the project ID and data region in Settings › Connections.`;
  if (status === 429) return `Mixpanel's limit of 60 queries an hour is used up. Try again in a few minutes.`;
  const said = /"error"\s*:\s*"([^"]+)"/.exec(body)?.[1];
  if (said) return `Mixpanel said: ${said}`;
  return `Kovan could not ${doing}: ${message}`;
}
