/**
 * Starting an agent on a piece of work.
 *
 * This is the join between four things that are separately testable and
 * deliberately kept apart: which agents exist (`@baton/agent`), what to say to
 * one (`@baton/core`'s prompts), where to run it (`@baton/git`), and the folder
 * that records it (`RunStore`).
 */

import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  DEFAULTISSUETEMPLATE,
  DEFAULTREVIEWTEMPLATE,
  DEFAULTUPDATETEMPLATE,
  DEFAULTVERIFYTEMPLATE,
  renderIssuePrompt,
  renderPullPrompt,
  ticketKeyInTitle,
  type Conventions,
  type JiraIssue,
  type PullSummary
} from '@baton/core';
import { RunStore, available, type RunKind, type Runner } from '@baton/agent';
import { findClones, runTargets, type RunTarget } from '@baton/git';
import type { DesktopHost } from './host';
import type { Sessions } from './sessions';

export interface StartRequest {
  kind: RunKind;
  /** A `repo#number` for a pull request, or a ticket key. */
  subjectId: string;
  runnerId: string;
  /** Working directory. Defaults to the best guess for the subject. */
  cwd?: string;
  /** Lets the user edit the prompt before it is sent. */
  prompt?: string;
}

export class Agents {
  private readonly store: RunStore;
  private cachedTargets?: RunTarget[];

  constructor(
    private readonly host: DesktopHost,
    private readonly sessions: Sessions
  ) {
    this.store = new RunStore(RunStore.rootFor(host.files.stateDir()));
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
  buildPrompt(
    kind: RunKind,
    subject: { pull?: PullSummary; issue?: JiraIssue }
  ): string {
    const reviewers = this.host.config.get('runner.reviewers', [] as string[]);
    const conventions = this.conventions();

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
    const template =
      kind === 'review'
        ? this.host.config.get('prompt.template.review', '') || DEFAULTREVIEWTEMPLATE
        : kind === 'verify'
          ? this.host.config.get('prompt.template.verify', '') || DEFAULTVERIFYTEMPLATE
          : this.host.config.get('prompt.template.unblock', '') || DEFAULTUPDATETEMPLATE;

    return renderPullPrompt(template, subject.pull, { reviewers, conventions });
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
  subjectFor(pull?: PullSummary, issue?: JiraIssue): string {
    if (issue) return issue.key;
    if (!pull) return 'unknown';
    return ticketKeyInTitle(pull.title) || `${pull.repo}#${pull.number}`;
  }

  async start(
    request: StartRequest,
    subject: { pull?: PullSummary; issue?: JiraIssue }
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

    const subjectId = this.subjectFor(subject.pull, subject.issue);
    const run = await this.store.begin({
      subject: subjectId,
      pull: subject.pull ? `${subject.pull.repo}#${subject.pull.number}` : '',
      kind: request.kind,
      prompt
    });

    // Everything already known about this ticket, so the agent does not start
    // from nothing. The prompts tell it to read this first.
    const ticketFile = await this.writeTicketFile(run.directory, subject);

    const result = await this.sessions.run({
      runner,
      prompt,
      cwd,
      title: `${request.kind} · ${subjectId}`,
      run,
      env: this.store.env(run, ticketFile)
    });

    if ('error' in result) {
      return { ok: false, error: result.error };
    }
    this.host.log.info(`started ${request.kind} on ${subjectId} in ${cwd}`);
    return { ok: true, sessionId: result.id };
  }

  private async writeTicketFile(
    directory: string,
    subject: { pull?: PullSummary; issue?: JiraIssue }
  ): Promise<string | undefined> {
    const lines: string[] = [];
    if (subject.issue) {
      lines.push(`# ${subject.issue.key} — ${subject.issue.summary}`, '');
      lines.push(`Status: ${subject.issue.status} · Type: ${subject.issue.issueType}`);
      lines.push(`URL: ${subject.issue.url}`, '', '## What was asked', '');
      lines.push(subject.issue.description || '(no description)');
      if (subject.issue.comments.length > 0) {
        lines.push('', '## Comments', '');
        for (const c of subject.issue.comments) {
          lines.push(`**${c.author}** (${c.created})`, '', c.body, '');
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

    const history = await this.store.list(this.subjectFor(subject.pull, subject.issue));
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
}
