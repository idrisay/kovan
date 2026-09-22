/**
 * Starting an agent on a piece of work.
 *
 * This is the join between four things that are separately testable and
 * deliberately kept apart: which agents exist (`@baton/agent`), what to say to
 * one (`@baton/core`'s prompts), where to run it (`@baton/git`), and the folder
 * that records it (`RunStore`).
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  DEFAULTISSUETEMPLATE,
  DEFAULTREVIEWTEMPLATE,
  DEFAULTUPDATETEMPLATE,
  DEFAULTVERIFYTEMPLATE,
  renderVerifyPrompt,
  renderIssuePrompt,
  renderPullPrompt,
  renderSentryPrompt,
  ticketKeyInTitle,
  type Conventions,
  type JiraIssue,
  type PullSummary,
  type SentryFrame,
  type SentryIssue
} from '@baton/core';
import { isAppFrame, resolveFrame } from '@baton/core/node';
import { RunStore, available, type RunKind, type Runner } from '@baton/agent';
import { findClones, runTargets, type RunTarget } from '@baton/git';
import { HttpClient, JiraClient, SentryClient, type RawSentryFrame } from '@baton/providers';
import type { DesktopHost } from './host';
import type { Sessions } from './sessions';

/**
 * Jira attachments arrive already inlined as base64 data URIs — that is for
 * the ticket pane's own rendering, not for an agent. Left as-is, every run
 * would carry whatever screenshots are pasted into the ticket straight into
 * `ticket.md`, which the prompts tell the agent to read first, every time,
 * whether or not the task has anything to do with what the image shows.
 */
const INLINE_IMAGE_PATTERN = /!\[([^\]]*)\]\((data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+)\)/g;

/**
 * Swaps each inlined image for a real file on disk plus a pointer to it, so
 * the agent's context stays text-sized but the image is still one `Read`
 * away if the task actually needs it.
 */
async function externalizeImages(markdown: string, directory: string): Promise<string> {
  const matches = [...markdown.matchAll(INLINE_IMAGE_PATTERN)];
  if (matches.length === 0) {
    return markdown;
  }

  const attachmentsDir = path.join(directory, 'attachments');
  await mkdir(attachmentsDir, { recursive: true });

  const replacements = new Map<string, string>();
  let index = 0;
  for (const [whole, alt, dataUrl] of matches) {
    if (replacements.has(whole)) continue;
    const parsed = /^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
    if (!parsed) continue;
    index += 1;
    const ext = parsed[1] === 'jpeg' ? 'jpg' : parsed[1];
    const file = path.join(attachmentsDir, `image-${index}.${ext}`);
    await writeFile(file, Buffer.from(parsed[2], 'base64'));
    replacements.set(whole, `_(image "${alt || `image-${index}`}" — open ${file} if you need to see it)_`);
  }

  return markdown.replace(INLINE_IMAGE_PATTERN, (whole) => replacements.get(whole) ?? whole);
}

export interface StartRequest {
  kind: RunKind;
  /** A `repo#number` for a pull request, or a ticket key. */
  subjectId: string;
  runnerId: string;
  /** Working directory. Defaults to the best guess for the subject. */
  cwd?: string;
  /** Lets the user edit the prompt before it is sent. */
  prompt?: string;
  /**
   * The model to run with, chosen in the run sheet. Left unset, `runnerFor()`
   * still picks its own per-kind default (review/verify on Claude default to
   * haiku) — an explicit choice here always wins over that default, never
   * the other way around.
   */
  model?: string;
}

/** Everything a run can be started against. Every field is optional because
 *  each caller only ever has one of them. */
export interface Subject {
  pull?: PullSummary;
  issue?: JiraIssue;
  sentry?: { issue: SentryIssue; frames: SentryFrame[] };
}

export class Agents {
  private readonly store: RunStore;
  private readonly http: HttpClient;
  private cachedTargets?: RunTarget[];

  constructor(
    private readonly host: DesktopHost,
    private readonly sessions: Sessions
  ) {
    this.store = new RunStore(RunStore.rootFor(host.files.stateDir()));
    this.http = new HttpClient(host.log);
  }

  runners(): Promise<Runner[]> {
    return available(this.host.config.get('runner.custom', []) as Runner[]);
  }

  /** Where a run can be started, from the watched folders and their clones. */
  async targets(force = false): Promise<RunTarget[]> {
    if (this.cachedTargets && !force) {
      return this.cachedTargets;
    }
    const folders = this.host.config.get('repos.folders', [] as string[]);
    this.cachedTargets = runTargets(await findClones(folders), folders);
    return this.cachedTargets;
  }

  private conventions(): Conventions {
    return this.host.config.get('prompt.conventions', {
      baseBranch: 'main',
      checks: [],
      untouchable: [],
      pullRequestReviewers: []
    }) as Conventions;
  }

  /** The prompt a given piece of work would be started with. */
  buildPrompt(kind: RunKind, subject: Subject): string {
    const reviewers = this.host.config.get('runner.reviewers', [] as string[]);
    const conventions = this.conventions();

    if (kind === 'implement' && subject.sentry) {
      return renderSentryPrompt(subject.sentry.issue, subject.sentry.frames, {
        template: this.host.config.get('prompt.template.sentry', '') || undefined,
        reviewers,
        conventions
      });
    }
    if (kind === 'implement' && subject.issue) {
      return renderIssuePrompt(subject.issue, {
        template: this.host.config.get('prompt.template.implement', '') || undefined,
        reviewers,
        conventions
      });
    }
    if (!subject.pull) {
      return '';
    }
    if (kind === 'verify') {
      // Its own renderer: the verify template needs ${env}, ${site},
      // ${verdicts} and ${basicAuth}, none of which renderPullPrompt knows —
      // and `substitute` leaves an unknown placeholder alone, so through the
      // general path all four reached the agent as literal text.
      return renderVerifyPrompt(
        this.host.config.get('prompt.template.verify', '') || DEFAULTVERIFYTEMPLATE,
        subject.pull,
        {
          name: this.host.config.get('verify.environment', ''),
          site: this.host.config.get('verify.site', ''),
          hasBasicAuth: this.host.config.get('verify.basicAuth', false)
        },
        { reviewers, conventions }
      );
    }

    const template =
      kind === 'review'
        ? this.host.config.get('prompt.template.review', '') || DEFAULTREVIEWTEMPLATE
        : this.host.config.get('prompt.template.unblock', '') || DEFAULTUPDATETEMPLATE;

    return renderPullPrompt(template, subject.pull, { reviewers, conventions });
  }

  /**
   * The runner to actually invoke, with a per-kind model swapped in.
   *
   * "review" and "verify" mostly read and judge; "implement" and "unblock"
   * write the code, so they keep whatever model the runner was configured
   * with. The built-in `claude` runner defaults the first two to a cheaper
   * model for that reason — overridable (or turned off with `''`) via the
   * `runner.models` setting, and left alone for any other runner, since its
   * model names are not Claude's.
   */
  private runnerFor(runner: Runner, kind: RunKind, explicitModel?: string): Runner {
    const overrides = this.host.config.get('runner.models', {} as Record<string, string>);
    const defaults: Record<string, string> = runner.id === 'claude' ? { review: 'haiku', verify: 'haiku' } : {};
    // A model chosen in the run sheet always wins — it is the one thing here
    // the user actually asked for, where the other two are just fallbacks for
    // when they did not.
    const model = explicitModel || overrides[kind] || defaults[kind];
    return model && runner.modelFlag ? { ...runner, model } : runner;
  }

  /**
   * The dev-environment credentials a "verify" run signs in with — handed to
   * the agent only as environment variables, never woven into the prompt
   * text, and named to match what `DEFAULTVERIFYTEMPLATE` already tells the
   * agent to read: `$BATON_ENV_USER`/`$BATON_ENV_PASSWORD` for the app's own
   * sign-in, `$BATON_ENV_BASIC_USER`/`$BATON_ENV_BASIC_PASSWORD` for an HTTP
   * Basic Auth wall in front of it. A field left unconfigured is simply
   * omitted, the same as an unanswered review request — the agent finds it
   * unset and reports `could not check` rather than guessing.
   */
  private async verifyEnv(): Promise<Record<string, string>> {
    const vars: Record<string, string> = {};
    const username = this.host.config.get('verify.username', '');
    const password = await this.host.secrets.get('verify.password');
    if (username) vars['BATON_ENV_USER'] = username;
    if (password) vars['BATON_ENV_PASSWORD'] = password;

    if (this.host.config.get('verify.basicAuth', false)) {
      const basicUsername = this.host.config.get('verify.basicUsername', '');
      const basicPassword = await this.host.secrets.get('verify.basicPassword');
      if (basicUsername) vars['BATON_ENV_BASIC_USER'] = basicUsername;
      if (basicPassword) vars['BATON_ENV_BASIC_PASSWORD'] = basicPassword;
    }
    return vars;
  }

  /**
   * The folder to start in.
   *
   * The clone matching the pull request's repository, when there is one.
   * Otherwise the first watched folder, because opening a terminal in the
   * user's home directory is never what they wanted.
   */
  async defaultCwd(repo?: string): Promise<string | undefined> {
    const targets = await this.targets();
    if (repo) {
      const match = targets.find((t) => t.label.toLowerCase() === repo.toLowerCase());
      if (match) return match.path;
    }
    return targets[0]?.path;
  }

  /**
   * Files the work under a ticket where it can find one.
   *
   * A ticket folder collects runs from every pull request that carried its key,
   * so the second time the same ticket comes round the first time is already
   * there.
   */
  subjectFor(pull?: PullSummary, issue?: JiraIssue, sentry?: SentryIssue): string {
    if (sentry) return sentry.shortId;
    if (issue) return issue.key;
    if (!pull) return 'unknown';
    return ticketKeyInTitle(pull.title) || `${pull.repo}#${pull.number}`;
  }

  async start(
    request: StartRequest,
    subject: Subject
  ): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
    const runners = await this.runners();
    const runner = runners.find((r) => r.id === request.runnerId);
    if (!runner) {
      return { ok: false, error: `No runner "${request.runnerId}". It may have been uninstalled.` };
    }

    const prompt = request.prompt ?? this.buildPrompt(request.kind, subject);
    const cwd = request.cwd ?? (await this.defaultCwd(subject.pull?.repo));
    if (!cwd) {
      return {
        ok: false,
        error: 'No folder to run in. Add a watched folder in Connections first.'
      };
    }

    const subjectId = this.subjectFor(subject.pull, subject.issue, subject.sentry?.issue);
    const run = await this.store.begin({
      subject: subjectId,
      pull: subject.pull ? `${subject.pull.repo}#${subject.pull.number}` : '',
      kind: request.kind,
      prompt
    });

    // Everything already known about this ticket, so the agent does not start
    // from nothing. The prompts tell it to read this first.
    const ticketFile = await this.writeTicketFile(run.directory, subject);

    const env = {
      ...this.store.env(run, ticketFile),
      ...(request.kind === 'verify' ? await this.verifyEnv() : {})
    };

    const result = await this.sessions.run({
      runner: this.runnerFor(runner, request.kind, request.model),
      prompt,
      cwd,
      title: `${request.kind} · ${subjectId}`,
      run,
      env
    });

    if ('error' in result) {
      return { ok: false, error: result.error };
    }
    this.host.log.info(`started ${request.kind} on ${subjectId} in ${cwd}`);
    return { ok: true, sessionId: result.id };
  }

  private async writeTicketFile(directory: string, subject: Subject): Promise<string | undefined> {
    const lines: string[] = [];
    if (subject.sentry) {
      const { issue, frames } = subject.sentry;
      lines.push(`# ${issue.shortId} — ${issue.title}`, '');
      lines.push(`Level: ${issue.level} · Culprit: ${issue.culprit || '(unknown)'}`);
      lines.push(`Seen ${issue.count} times, ${issue.userCount} users affected.`);
      lines.push(`First seen ${issue.firstSeen || 'unknown'}, last seen ${issue.lastSeen || 'unknown'}.`);
      lines.push(issue.permalink, '', '## Stack trace (outermost first, throw site last)', '');
      if (frames.length === 0) {
        lines.push('(no stack trace was available for the latest event)');
      } else {
        frames.forEach((f, i) => {
          const tag = f.inApp ? '' : '(dependency) ';
          const at = f.resolvedPath ?? f.filename ?? '(unknown file)';
          const line = f.lineNo && (f.resolvedPath ?? f.filename) ? `:${f.lineNo}` : '';
          const fn = f.function ? ` — ${f.function}` : '';
          lines.push(`${i + 1}. ${tag}${at}${line}${fn}`);
        });
      }
    }
    if (subject.issue) {
      lines.push(`# ${subject.issue.key} — ${subject.issue.summary}`, '');
      lines.push(`Status: ${subject.issue.status} · Type: ${subject.issue.issueType}`);
      lines.push(`URL: ${subject.issue.url}`, '', '## What was asked', '');
      lines.push(await externalizeImages(subject.issue.description || '(no description)', directory));
      if (subject.issue.comments.length > 0) {
        lines.push('', '## Comments', '');
        for (const c of subject.issue.comments) {
          lines.push(`**${c.author}** (${c.created})`, '', await externalizeImages(c.body, directory), '');
        }
      }
    }
    if (subject.pull) {
      lines.push('', `## Pull request ${subject.pull.repo}#${subject.pull.number}`, '');
      lines.push(subject.pull.title, subject.pull.url);
    }
    if (lines.length === 0) {
      return undefined;
    }

    const history = await this.store.list(this.subjectFor(subject.pull, subject.issue, subject.sentry?.issue));
    if (history.length > 0) {
      lines.push('', '## Earlier runs', '');
      for (const run of history.slice(0, 10)) {
        const when = new Date(run.startedAt).toISOString().slice(0, 16).replace('T', ' ');
        lines.push(`- ${when} · ${run.kind}${run.confidence ? ` · ${run.confidence}/100` : ''}`);
      }
    }

    const file = path.join(directory, 'ticket.md');
    await writeFile(file, lines.join('\n'), 'utf8');
    return file;
  }

  history(subject: string) {
    return this.store.list(subject);
  }

  /** Every file a run's directory actually contains, for the in-app viewer. */
  async runFiles(directory: string) {
    if (!this.store.owns(directory)) {
      throw new Error('Not a run directory.');
    }
    return this.store.files(directory);
  }

  /** A run's own report.md or prompt.md, read for the in-app viewer. */
  async readRunText(file: string): Promise<string> {
    if (!this.store.owns(file)) {
      throw new Error('Not a run file.');
    }
    return readFile(file, 'utf8');
  }

  /** A run's own screenshot, as a data URL the renderer can put straight in an `<img>`. */
  async readRunImage(file: string): Promise<string> {
    if (!this.store.owns(file)) {
      throw new Error('Not a run file.');
    }
    const bytes = await readFile(file);
    const ext = path.extname(file).slice(1).toLowerCase();
    const mime = ext === 'jpg' ? 'jpeg' : ext || 'png';
    return `data:image/${mime};base64,${bytes.toString('base64')}`;
  }

  private async sentryClient(): Promise<SentryClient> {
    const token = await this.host.secrets.get('sentry');
    const organization = this.host.config.get('sentry.organization', '');
    if (!token || !organization) {
      throw new Error('Sentry is not connected.');
    }
    return new SentryClient(this.http, this.host.config.get('sentry.baseUrl', 'https://sentry.io'), organization, token);
  }

  /**
   * One issue's latest stack trace, each frame placed on disk where possible.
   * `repoRoot` is the first watched folder — the same fallback `defaultCwd()`
   * uses, since a Sentry issue carries no repository hint of its own to match
   * a clone against.
   */
  async sentryFrames(issueId: string): Promise<SentryFrame[]> {
    const client = await this.sentryClient();
    const raw = await client.getLatestFrames(issueId);
    const repoRoot = await this.defaultCwd();
    return raw.map((f: RawSentryFrame) => {
      const resolvedPath =
        repoRoot && f.filename
          ? resolveFrame(f.filename, { repoRoot, mappings: [] })
          : undefined;
      return {
        filename: f.filename,
        function: f.function,
        lineNo: f.lineNo,
        colNo: f.colNo,
        inApp: isAppFrame(f),
        resolvedPath: resolvedPath && existsSync(resolvedPath) ? resolvedPath : undefined
      };
    });
  }

  /**
   * Files a Jira ticket from a Sentry issue — the other action the tab
   * offers besides starting an agent. Needs a default project, which is not
   * part of `CREDENTIAL_FIELDS.jira` (only "create ticket" needs it, so an
   * already-working Jira connection with no project set stays "connected").
   */
  async createTicketFromSentry(issue: SentryIssue): Promise<{ key: string; url: string }> {
    const projectKey = this.host.config.get('jira.projectKey', '');
    if (!projectKey) {
      throw new Error('No default Jira project set. Add one in Settings → Jira.');
    }
    const token = await this.host.secrets.get('jira');
    const site = this.host.config.get('jira.baseUrl', '');
    const email = this.host.config.get('jira.email', '');
    if (!token || !site || !email) {
      throw new Error('Jira is not connected.');
    }
    const description =
      `${issue.permalink}\n\n` +
      `Level: ${issue.level} · Culprit: ${issue.culprit || '(unknown)'}\n` +
      `Seen ${issue.count} times, ${issue.userCount} users affected.`;
    return new JiraClient(this.http, site, email, token).createIssue(
      projectKey,
      `[Sentry] ${issue.title}`,
      description
    );
  }
}
