/**
 * The quick model's jobs: "Summarize" on a pull request, "Condense" on a
 * ticket. Only ever started by a click — nothing here runs on a timer or on
 * opening a pane.
 *
 * Main-process-first like the poller: a job keeps running when the window
 * closes or the pane changes, and its result is saved, so the card is there
 * when you come back. The renderer only asks for state and listens.
 *
 * Two things are kept on disk, for two different readers:
 * - `quick/<subject>.json` — the latest result per kind, which the cards and
 *   `ticket.md` read.
 * - `quick/jobs.json` — every recent job with what it read, what it was told,
 *   what came back and what it cost, which the Sessions tab lists.
 */

import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  CONDENSE_INSTRUCTION,
  KIMI_REVIEW_FILE,
  KIMI_REVIEW_TIMEOUT_SECONDS,
  NV_REVIEW_DEFAULT_MODEL,
  NV_REVIEW_SUFFIX,
  isNvReviewModel,
  PULL_SUMMARY_INSTRUCTION,
  QUICK_DEFAULT_MODEL,
  QUICK_DEFAULT_TIMEOUT_SECONDS,
  QUICK_JOB_LIMIT,
  condenseInput,
  olderCommentCount,
  pullBasis,
  parseOpencodeModels,
  pullReviewPrompt,
  pullSummaryInput,
  reviewBasis,
  reviewModelName,
  reviewSubmissionBody,
  splitVerdict,
  ticketBasis,
  ticketKeyInTitle,
  type QuickBasis,
  type QuickJob,
  type QuickKind,
  type QuickPullInput,
  type QuickResult,
  type QuickTicketInput,
  type ReviewEvent
} from '@kovan/core';
import {
  QUICK_OPENCODE_CONFIG, RunStore, loginShell, parseQuickOutput, quickArgs, shellEnvironment, subjectSlug,
  type QuickOutput
} from '@kovan/agent';
import type { DesktopHost } from './host';

export interface QuickState {
  result?: QuickResult;
  /** Epoch ms the running job started, when one is running. */
  running?: number;
  error?: string;
}

export interface QuickSources {
  pull(repo: string, number: number): Promise<QuickPullInput>;
  ticket(key: string): Promise<QuickTicketInput>;
  diff(repo: string, number: number): Promise<string>;
  submitReview(repo: string, number: number, event: ReviewEvent, body: string): Promise<{ url?: string }>;
}

/** A job while it runs: the record the Sessions tab shows, plus its process. */
interface Live {
  job: QuickJob;
  child?: ChildProcess;
}

/** Enough of a stored job's input to recognise it; a huge PR is cut here. */
const STORED_INPUT_LIMIT = 40_000;

type Saved = Partial<Record<QuickKind, QuickResult>>;

export class QuickModel {
  private readonly dir: string;
  /** Where the Kimi K3 review is filed, beside the PR's agent runs. */
  private readonly runs: RunStore;
  private readonly live = new Map<string, Live>();
  /** The last failure per kind+subject, until the next run or dismiss clears it. */
  private readonly errors = new Map<string, string>();
  private jobs: QuickJob[] = [];
  /** Jobs closed from the Sessions list; a running one finishing later must not come back. */
  private readonly removed = new Set<string>();
  private readonly loaded: Promise<void>;
  private listener?: (kind: QuickKind, subject: string, state: QuickState) => void;
  private jobsListener?: (jobs: QuickJob[]) => void;

  constructor(
    private readonly host: DesktopHost,
    private readonly sources: QuickSources
  ) {
    this.dir = path.join(host.files.stateDir(), 'quick');
    this.runs = new RunStore(RunStore.rootFor(host.files.stateDir()));
    this.loaded = this.loadJobs();
  }

  onChange(listener: (kind: QuickKind, subject: string, state: QuickState) => void): void {
    this.listener = listener;
  }

  onJobs(listener: (jobs: QuickJob[]) => void): void {
    this.jobsListener = listener;
  }

  /**
   * The opencode model a kind runs on: its own pick from the button's model
   * tag (`quick.models`), else Settings' one quick model, else the default.
   */
  model(kind?: QuickKind): string {
    const own = kind ? this.host.config.get<Partial<Record<QuickKind, string>>>('quick.models', {})[kind] : undefined;
    return own || this.host.config.get('quick.model', '') || QUICK_DEFAULT_MODEL;
  }

  /**
   * What the button's tag shows and its picker edits. The review runs either
   * through `nv-review` (`moonshotai/kimi-k3 (nv-review)`, see
   * `NV_REVIEW_SUFFIX`) or on any opencode model, like Summarize.
   */
  modelFor(kind: QuickKind): string {
    if (kind !== 'pull-review') return this.model(kind);
    if (this.host.config.get<string>('review.runner', 'nv-review') === 'opencode') {
      return this.host.config.get<Partial<Record<QuickKind, string>>>('quick.models', {})['pull-review'] || QUICK_DEFAULT_MODEL;
    }
    return `${this.reviewModel()}${NV_REVIEW_SUFFIX}`;
  }

  async setModelFor(kind: QuickKind, model: string): Promise<void> {
    const value = model.trim();
    if (!value) return;
    if (kind === 'pull-review' && isNvReviewModel(value)) {
      await this.host.config.set('review.runner', 'nv-review');
      await this.host.config.set('review.nvModel', value.slice(0, -NV_REVIEW_SUFFIX.length).trim());
      return;
    }
    if (kind === 'pull-review') await this.host.config.set('review.runner', 'opencode');
    const all = this.host.config.get<Partial<Record<QuickKind, string>>>('quick.models', {});
    await this.host.config.set('quick.models', { ...all, [kind]: value });
  }

  private listed?: Promise<string[]>;

  /**
   * Every model opencode can run, as `provider/model` — `opencode models`,
   * asked once per launch when a picker first opens, never before.
   */
  available(fresh = false): Promise<string[]> {
    if (fresh) this.listed = undefined;
    this.listed ??= (async () => {
      if (process.env['KOVAN_SMOKE'] && process.env['KOVAN_USER_DATA']) {
        return [QUICK_DEFAULT_MODEL, 'opencode/grok-code-fast-free', 'anthropic/claude-haiku-4-5', 'openai/gpt-5-mini'];
      }
      const opencode = await shellEnvironment.which('opencode');
      if (!opencode) return [];
      const env = { ...(await shellEnvironment.environment()), OPENCODE_CONFIG_CONTENT: QUICK_OPENCODE_CONFIG };
      const stdout = await new Promise<string>((resolve) => {
        const child = spawn(opencode, ['models'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
        const timer = setTimeout(() => child.kill('SIGTERM'), 30_000);
        child.on('close', () => { clearTimeout(timer); resolve(out); });
        child.on('error', () => { clearTimeout(timer); resolve(''); });
      });
      return parseOpencodeModels(stdout);
    })();
    // A failed or empty listing is asked again next time rather than cached.
    void this.listed.then((list) => { if (list.length === 0) this.listed = undefined; });
    return this.listed;
  }

  /** The NVIDIA model `nv-review` is told to use — its `NV_MODEL`. */
  reviewModel(): string {
    return this.host.config.get('review.nvModel', '') || NV_REVIEW_DEFAULT_MODEL;
  }

  private timeoutMs(): number {
    const seconds = Number(this.host.config.get('quick.timeoutSeconds', QUICK_DEFAULT_TIMEOUT_SECONDS));
    return (Number.isFinite(seconds) && seconds >= 10 ? seconds : QUICK_DEFAULT_TIMEOUT_SECONDS) * 1000;
  }

  // --- Saved results, per subject ---------------------------------------------------

  private file(subject: string): string {
    return path.join(this.dir, `${subjectSlug(subject)}.json`);
  }

  private async load(subject: string): Promise<Saved> {
    try {
      return JSON.parse(await readFile(this.file(subject), 'utf8')) as Saved;
    } catch {
      return {};
    }
  }

  private async save(subject: string, saved: Saved): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(subject), JSON.stringify(saved, null, 2), 'utf8');
  }

  async result(kind: QuickKind, subject: string): Promise<QuickResult | undefined> {
    return (await this.load(subject))[kind];
  }

  async state(kind: QuickKind, subject: string): Promise<QuickState> {
    const live = this.live.get(`${kind}:${subject}`);
    return {
      result: await this.result(kind, subject),
      running: live?.job.startedAt,
      error: this.errors.get(`${kind}:${subject}`)
    };
  }

  private async emit(kind: QuickKind, subject: string): Promise<void> {
    this.listener?.(kind, subject, await this.state(kind, subject));
  }

  // --- The job log --------------------------------------------------------------------

  private jobsFile(): string {
    return path.join(this.dir, 'jobs.json');
  }

  private async loadJobs(): Promise<void> {
    try {
      const stored = JSON.parse(await readFile(this.jobsFile(), 'utf8')) as QuickJob[];
      // Anything still "running" on disk was running when Kovan last quit.
      this.jobs = stored.map((job) =>
        job.status === 'running' ? { ...job, status: 'failed', error: 'Kovan quit while this was running.' } : job
      );
    } catch {
      this.jobs = [];
    }
  }

  /** Newest first. */
  async listJobs(): Promise<QuickJob[]> {
    await this.loaded;
    return this.jobs;
  }

  private async recordJob(job: QuickJob): Promise<void> {
    await this.loaded;
    if (this.removed.has(job.id)) return;
    this.jobs = [job, ...this.jobs.filter((j) => j.id !== job.id)].slice(0, QUICK_JOB_LIMIT);
    this.jobsListener?.(this.jobs);
    // Only settled jobs are worth a disk write; a running one is written again
    // the moment it finishes.
    if (job.status !== 'running') {
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.jobsFile(), JSON.stringify(this.jobs), 'utf8');
    }
  }

  // --- Running ------------------------------------------------------------------------

  /** Starts a job and returns at once; progress arrives through the listeners. */
  run(kind: QuickKind, subject: string): void {
    // Both arrive over IPC: a kind this class does not know would otherwise
    // fall through to the ticket branch below.
    if ((kind !== 'pull-summary' && kind !== 'ticket-condense' && kind !== 'pull-review') || !subject) return;
    const key = `${kind}:${subject}`;
    if (this.live.has(key)) return;
    const live: Live = {
      job: {
        id: randomUUID(), kind, subject, status: 'running', startedAt: Date.now(),
        model: this.modelFor(kind)
      }
    };
    this.live.set(key, live);
    this.errors.delete(key);
    void this.recordJob(live.job);
    void this.emit(kind, subject);

    void this.execute(live)
      .then(async (result) => {
        const saved = await this.load(subject);
        saved[kind] = result;
        await this.save(subject, saved);
        live.job = { ...live.job, status: 'done' };
        this.host.log.info(`quick ${kind} on ${subject} in ${Date.now() - live.job.startedAt}ms`);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        const cancelled = live.job.status === 'cancelled';
        live.job = { ...live.job, status: cancelled ? 'cancelled' : 'failed', error: message };
        if (!cancelled) {
          this.errors.set(key, message);
          this.host.log.warn(`quick ${kind} on ${subject} failed: ${message}`);
        }
      })
      .finally(() => {
        this.live.delete(key);
        void this.recordJob({ ...live.job, finishedAt: Date.now() });
        void this.emit(kind, subject);
      });
  }

  cancel(kind: QuickKind, subject: string): void {
    const live = this.live.get(`${kind}:${subject}`);
    if (!live) return;
    live.job = { ...live.job, status: 'cancelled' };
    live.child?.kill('SIGTERM');
  }

  /** Closes a job's row in the Sessions list — cancelling it first if it is still running. */
  async removeJob(id: string): Promise<void> {
    await this.loaded;
    const live = [...this.live.values()].find((l) => l.job.id === id);
    if (live) this.cancel(live.job.kind, live.job.subject);
    this.removed.add(id);
    this.jobs = this.jobs.filter((j) => j.id !== id);
    this.jobsListener?.(this.jobs);
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.jobsFile(), JSON.stringify(this.jobs), 'utf8');
  }

  async dismiss(kind: QuickKind, subject: string): Promise<void> {
    this.errors.delete(`${kind}:${subject}`);
    const saved = await this.load(subject);
    if (saved[kind]) {
      delete saved[kind];
      await this.save(subject, saved);
    }
    await this.emit(kind, subject);
  }

  /** Settings' Test button: one tiny round trip, timed. Not a job; not logged. */
  async test(model?: string): Promise<{ ok: boolean; ms: number; error?: string }> {
    const started = Date.now();
    const output = await this.ask(model || this.model(), 'Reply with the single word: ok', 'Reply exactly as the attached file asks.')
      .catch((err: unknown): QuickOutput => ({ error: err instanceof Error ? err.message : String(err), refused: [] }));
    return output.text
      ? { ok: true, ms: Date.now() - started }
      : { ok: false, ms: Date.now() - started, error: output.error };
  }

  private async execute(live: Live): Promise<QuickResult> {
    const { kind, subject, model } = live.job;
    let material: string;
    let instruction: string;
    let basis: QuickBasis;
    if (kind === 'pull-review') {
      return this.review(live);
    }
    if (kind === 'pull-summary') {
      const hash = subject.lastIndexOf('#');
      const detail = await this.sources.pull(subject.slice(0, hash), Number(subject.slice(hash + 1)));
      [material, instruction, basis] = [pullSummaryInput(detail), PULL_SUMMARY_INSTRUCTION, pullBasis(detail)];
    } else {
      const issue = await this.sources.ticket(subject);
      if (olderCommentCount(issue.comments.length) === 0) {
        throw new Error('Nothing to condense: this ticket has no comments older than the latest few.');
      }
      [material, instruction, basis] = [condenseInput(issue), CONDENSE_INSTRUCTION, ticketBasis(issue)];
    }

    live.job = { ...live.job, input: this.forLog(material), instruction };
    void this.recordJob(live.job);

    const output = await this.ask(model, material, instruction, live);
    live.job = { ...live.job, answer: output.text, tokens: output.tokens, refused: output.refused };
    if (!output.text) throw new Error(output.error);
    return { kind, subject, text: output.text, model, createdAt: new Date().toISOString(), basis };
  }

  private async review(live: Live): Promise<QuickResult> {
    const { kind, subject, model } = live.job;
    const hash = subject.lastIndexOf('#');
    const [repo, number] = [subject.slice(0, hash), Number(subject.slice(hash + 1))];
    const [detail, diff] = await Promise.all([this.sources.pull(repo, number), this.sources.diff(repo, number)]);
    const prompt = pullReviewPrompt(detail, diff);
    live.job = { ...live.job, input: this.forLog(prompt) };
    void this.recordJob(live.job);

    const answer = isNvReviewModel(model) ? await this.nvReview(prompt, live) : await this.opencodeReview(model, prompt, live);
    const { text, verdict } = splitVerdict(answer);
    live.job = { ...live.job, answer, refused: [] };

    // Filed beside the PR's agent runs — under its ticket when the title names
    // one, exactly as `Agents.subjectFor` files them — so History shows it.
    const run = await this.runs.begin({
      subject: ticketKeyInTitle(detail.title) || subject,
      pull: subject,
      kind: 'review',
      prompt
    });
    const file = path.join(run.directory, KIMI_REVIEW_FILE);
    const recommends = verdict === 'approve' ? 'Approve' : verdict === 'request_changes' ? 'Request changes' : 'no verdict given';
    await writeFile(
      file,
      `# ${reviewModelName(model)} review of ${subject}\n\n_${model}, ${new Date().toISOString()}. Recommends: ${recommends}._\n\n${text}\n`,
      'utf8'
    );
    this.host.log.info(`nv-review saved to ${file}`);
    return { kind, subject, text, model, createdAt: new Date().toISOString(), basis: reviewBasis(detail), verdict };
  }

  /**
   * Posts the saved review to GitHub as the user's own review. Refuses a
   * review that no longer matches the pull request: approving code the model
   * never saw is the one outcome this must not produce.
   */
  async submitReview(subject: string, event: ReviewEvent): Promise<{ ok: boolean; error?: string }> {
    if (event !== 'APPROVE' && event !== 'REQUEST_CHANGES' && event !== 'COMMENT') {
      return { ok: false, error: 'Unknown review action.' };
    }
    const saved = await this.load(subject);
    const result = saved['pull-review'];
    if (!result) return { ok: false, error: 'There is no review to submit.' };
    const hash = subject.lastIndexOf('#');
    const [repo, number] = [subject.slice(0, hash), Number(subject.slice(hash + 1))];
    try {
      const detail = await this.sources.pull(repo, number);
      const now = reviewBasis(detail);
      const changed = Object.keys(now).some((k) => (now[k] ?? 0) !== (result.basis[k] ?? 0));
      if (changed) {
        return { ok: false, error: 'New changes were pushed since this review ran. Refresh the review before submitting it.' };
      }
      const via = isNvReviewModel(result.model) ? 'nv-review' : 'opencode';
      const posted = await this.sources.submitReview(repo, number, event, reviewSubmissionBody(result.text, reviewModelName(result.model), via));
      saved['pull-review'] = { ...result, submitted: { event, at: new Date().toISOString(), url: posted.url } };
      await this.save(subject, saved);
      this.host.log.info(`review on ${subject} submitted as ${event}`);
      await this.emit('pull-review', subject);
      return { ok: true };
    } catch (err) {
      // An HttpError carries GitHub's own explanation in its body.
      const body = (err as { body?: string }).body ?? '';
      const message = `${err instanceof Error ? err.message : String(err)}${body ? ` ${body}` : ''}`;
      this.host.log.warn(`review submit on ${subject} failed: ${message}`);
      return { ok: false, error: githubReviewError(message) };
    }
  }

  private forLog(material: string): string {
    return material.length > STORED_INPUT_LIMIT
      ? `${material.slice(0, STORED_INPUT_LIMIT)}\n\n… (${material.length - STORED_INPUT_LIMIT} more characters not kept in the log)`
      : material;
  }

  /**
   * The review on an opencode model: the whole review prompt goes in as the
   * attached file, the same way Summarize sends its material. Given the
   * review's own long limit, not the quick model's 90 seconds: a review reads
   * a whole diff.
   */
  private async opencodeReview(model: string, prompt: string, live: Live): Promise<string> {
    const output = await this.ask(
      model, prompt,
      'The attached file is a code review request. Do exactly what it asks, in the format it asks for.',
      live, KIMI_REVIEW_TIMEOUT_SECONDS * 1000
    );
    if (!output.text) throw new Error(output.error || `${reviewModelName(model)} returned nothing.`);
    return output.text.trim();
  }

  /**
   * Your `nv-review` shell function, prompt on stdin. It is a function in
   * `.zshrc`, so only an interactive shell can see it; the script is a fixed
   * word of ours and the prompt never passes through the parser.
   */
  private async nvReview(prompt: string, live: Live): Promise<string> {
    const env = { ...(await shellEnvironment.environment()), NV_MODEL: this.reviewModel() };
    const cwd = await mkdtemp(path.join(tmpdir(), 'kovan-review-'));
    try {
      return await new Promise<string>((resolve, reject) => {
        const child = spawn(loginShell(), ['-i', '-c', 'nv-review'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
        live.child = child;
        let out = '';
        let err = '';
        child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
        child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error(`${reviewModelName(this.reviewModel())} did not answer within ${KIMI_REVIEW_TIMEOUT_SECONDS / 60} minutes.`));
        }, KIMI_REVIEW_TIMEOUT_SECONDS * 1000);
        child.on('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (live.job.status === 'cancelled') return reject(new Error('Cancelled.'));
          // An interactive zsh prints rc noise to stderr; nv-review's own
          // messages are the lines it prefixes with its name.
          const own = err.split('\n').filter((line) => line.startsWith('nv-review:')).join('\n');
          if (code !== 0) return reject(new Error(own || err.trim().split('\n').pop() || `nv-review exited ${code}`));
          if (!out.trim() || out.trim() === '(empty response)') return reject(new Error(own || `${reviewModelName(this.reviewModel())} returned nothing.`));
          resolve(out.trim());
        });
        child.stdin.end(prompt, 'utf8');
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  /**
   * One `opencode run` in an empty temp folder, material attached as a file.
   * See `@kovan/agent`'s `quick.ts` for why the tools are "ask", not "deny".
   */
  private async ask(model: string, material: string, instruction: string, live?: Live, timeoutMs = this.timeoutMs()): Promise<QuickOutput> {
    const opencode = await shellEnvironment.which('opencode');
    if (!opencode) {
      throw new Error('opencode is not installed, or not on your login shell\'s PATH.');
    }
    const env = { ...(await shellEnvironment.environment()), OPENCODE_CONFIG_CONTENT: QUICK_OPENCODE_CONFIG };
    const cwd = await mkdtemp(path.join(tmpdir(), 'kovan-quick-'));
    try {
      const input = path.join(cwd, 'input.md');
      await writeFile(input, material, 'utf8');
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn(opencode, quickArgs(model, input, instruction), {
          cwd, env, stdio: ['ignore', 'pipe', 'pipe']
        });
        if (live) live.child = child;
        let out = '';
        let err = '';
        child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
        child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error(`The quick model did not answer within ${Math.round(timeoutMs / 1000)}s.`));
        }, timeoutMs);
        child.on('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.on('close', () => {
          clearTimeout(timer);
          if (live?.job.status === 'cancelled') reject(new Error('Cancelled.'));
          // opencode exits non-zero on a provider error but still prints the
          // error event, which says more than the exit code does.
          else resolve(out || err);
        });
      });
      return parseQuickOutput(stdout);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}

/** GitHub's refusals, in words that say what to do about them. */
function githubReviewError(message: string): string {
  if (/own pull request/i.test(message)) return 'GitHub does not let you approve or request changes on your own pull request. Use Comment instead.';
  if (/HTTP (403|404)\b/.test(message)) return 'GitHub refused the review. Your token may not have write access to this repository.';
  const said = /"message"\s*:\s*"([^"]+)"/.exec(message)?.[1];
  return said ? `GitHub refused the review: ${said}` : message;
}
