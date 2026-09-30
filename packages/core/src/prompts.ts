/**
 * The prompts an agent is handed, ported verbatim from
 * `DevHubCore/Prompts.swift`.
 *
 * These are not boilerplate. Every line is a mistake somebody made once, and
 * the two-stage gate in the issue template is the entire design: an agent
 * handed a ticket will investigate and implement in one breath, and the
 * investigation is the part worth reading — it is where the ambiguities are,
 * and an ambiguity resolved by a guess is a rewrite. Stage 1 therefore ends in
 * a confidence score and a list of questions, and stops. A high score does not
 * start Stage 2; only the user does.
 *
 * `$DEVHUB_*` became `$KOVAN_*` — the variables are named in the prompt text,
 * so `packages/agent`'s RUN_ENV and these strings have to agree.
 */

import type { PullSummary } from './github/pullStatus';
import { describePull } from './github/pullStatus';
import type { JiraIssue, SentryFrame, SentryIssue } from './types';
import { verifyAccountsClause, type TestAccount } from './testAccounts';

export const DEFAULTREVIEWTEMPLATE = `Review \${url} using gh.

Check the diff's size first with \`gh pr diff \${number} --repo \${repo}  --stat\`. For a small diff, just read it. For a large one, read it file by  file rather than pulling the whole thing into context at once — a  multi-thousand-line diff read in one shot is expensive and mostly noise.

Read the pull request, its diff and its threads, and retrieve the related  ticket for context if there is one. Understand what it is supposed to do  before judging whether it does it.

\${reviewers}
Then submit a single, concise review to GitHub as my review, folding in  everything you confirmed above. One review, not a running commentary.

\${attribution}

\${report}`;

export const DEFAULTUPDATETEMPLATE = `Update \${url} using gh. It is currently blocked on: \${state}.

Read the review threads with \`gh pr view \${number} --repo \${repo}  --comments\`, the failing jobs with \`gh pr checks \${number} --repo \${repo}\`,  and the changes with \`gh pr diff \${number} --repo \${repo}\` — check its size  with \`--stat\` first, and for a large diff read it file by file rather than  all at once. Retrieve the related ticket for context if there is one.

Then address every unresolved review comment, rebase onto the base branch  if it conflicts, and fix whatever the checks are failing on.

Verify locally before pushing:

\${checks}

Do not claim a check passed unless it actually ran and succeeded.

\${reviewers}
Push the result and reply to each review thread saying what you changed, as  my reply.

\${attribution}

\${report}`;

export const DEFAULTISSUETEMPLATE = `Implement the Jira ticket \${url} in two stages: investigate first,  implement only after my explicit green flag.

\${url} is the source of truth for this work. Its key is \${key}; use that as  <number> throughout.

# === STAGE 1 — INVESTIGATE ===

# DO NOT CHANGE A SINGLE LINE OF CODE

1. Retrieve the ticket from \${url} using the Atlassian MCP connector, never  the jira CLI. Read the description, the acceptance criteria, the comments  and any relevant linked issues.

2. If the ticket links a Figma design, read it with the Figma MCP  \`get_design_context\` tool. That call is the ONLY source of truth for exact  styles, classes, tokens, spacing, typography, component properties and  other implementation values. Fetch the screenshots too, for visual context  — but do not infer any exact value from a screenshot.

3. Investigate the codebase without modifying anything: the files that own  this behaviour, the patterns nearby, related components, existing tests,  relevant hooks and utilities, the i18n and accessibility patterns,  responsive behaviour, runtime risks, and anything this could break.

4. Report this, and nothing else:

### 🎯 Confidence

**Score: XX/100**

### ✅ What is clear

The requirements and implementation details that are unambiguous.

### ⚠️ What is ambiguous

For each: the ambiguity, the assumption you would make, and the impact if  that assumption is wrong.

### 📁 Files I would touch

A table of file and why.

### ❓ Questions that would raise the score

A table of priority (🔴 High / 🟠 Medium / 🟡 Low), the question, your  current assumption, and how many points an answer would add. Order it by  how much each answer would help.

Then STOP. Do not implement, branch, edit, commit, push or open a pull  request. Wait for my explicit green flag.

If I answer your questions, give me the updated score, the revised  assumptions and any changed decisions — then STOP again. A high score does  not start Stage 2. Only my explicit green flag does.

# === STAGE 2 — IMPLEMENT ===

Only after I say to proceed.

## 1. Branch

    git fetch origin \${base} && git checkout -b <type>/\${key}-<short-kebab-description> origin/\${base}

\`<type>\` is \`feat\` or \`bug\` as appropriate. Never implement on \${base}.

## 2. Implement

Follow, in this order: the acceptance criteria, the Stage 1 decisions I  confirmed, the existing patterns in this codebase, and the exact Figma  \`get_design_context\` values where they apply.

For UI work, verify what you wrote against the exact classes, tokens and  values \`get_design_context\` returned. Do not substitute values read off a  screenshot and do not invent any. Where the design and the existing  component system disagree, say so explicitly rather than silently picking  one.

Respect the existing patterns for i18n, accessibility, responsive  behaviour, error handling, loading and empty states, shared components,  hooks and utilities, and tests.\${untouchable}

Keep \${key} and spec identifiers such as FR-37, NFR-5 or AC-33 out of code  comments and test names. They belong in the commit scope and the pull  request, not in the implementation.

## 3. Verify locally

\${checks}

Fix everything those surface, and run the relevant tests where they exist.  Do not claim a check passed unless it actually ran and succeeded.

\${reviewers}
# === CONFIDENCE ===

Before committing, score the delivered work. This is a fresh assessment,  not the Stage 1 number — a high Stage 1 score does not imply a high one  here.

**Score: XX/100**, for how faithfully the code satisfies \${url}.

Then a row per acceptance criterion — 🟢 Met, 🟠 Partially met, 🔴 Not met,  ⚪ Cannot verify — each with the file and line or the check that supports  it. Then, for every value \`get_design_context\` returned, a row of expected  against implemented and whether it matches, with every deviation explained.

Then split what you actually proved — by type-check, lint, tests, a  rendered check, reading the file, the real design context — from what you  only inferred from reading code. List every assumption that made it into  the implementation, why it was necessary and what breaks if it is wrong.  Finish with the residual risk: what could still be wrong, what was not  tested, what depends on something external. Be honest — 72/100 with  reasons is worth more than a false 95.

## Stop conditions

If the score is below 80, or any acceptance criterion is 🔴 Not met: STOP.  Do not commit, push or open a pull request. Report and wait for me.

# === SHIP ===

Commit with \${key} as the conventional-commit scope, e.g.  \`fix(\${key}): what changed\`. Push the branch.

\${prReviewers}
Open the pull request against \${base}, requesting exactly the reviewers I  chose. Title it \`<type>/\${key} <the Jira title>\`. The body is a Summary of  two to four bullets and the Jira link, and nothing else — no test plan.

\${attribution}

\${report}`;

export const REPORTRULE = `# === LEAVE A RECORD ===

Before you finish, write what you did to \`$KOVAN_REPORT\`. Kovan collects  these into the ticket's own file, so this is what the next person — or the  next you — reads instead of starting again.

Say what you set out to do, what you actually changed and where, what you  verified and how, what you decided and why, and what is still uncertain.  Include the findings table if there was a review. Be specific about file  paths. If you were stopped part way, write that down too — a short honest  record beats none.

If you take screenshots, save them as PNGs in \`$KOVAN_SHOTS\`, numbered in  the order you took them and named for what they show, e.g.  \`01-lesson-page.png\`. They are shown with the report. Save each one as  you take it rather than all at the end: Kovan shows them live while you  work. As you go, overwrite \`$KOVAN_STATUS\` with one short line saying  what you are doing now, e.g. \`echo "Signing in as Teacher" > "$KOVAN_STATUS"\`.  When a screenshot shows a web page, also append its file name and the page's full address to \`$KOVAN_PAGES\`, e.g. \`echo "01-lesson-page.png https://…/lesson/12" >> "$KOVAN_PAGES"\`, so the page can be opened from Kovan.

Read \`$KOVAN_TICKET\` first if it exists: it is everything already known  about this ticket — what was asked for under "What was asked", the pull  requests that carried it, and every earlier run with what it concluded.  Do not edit it — Kovan rebuilds it from these reports.`;

export const ATTRIBUTIONRULE = `Everything you write externally — commit messages, pull request titles and  descriptions, pull request and review comments, Jira comments — is written  as me. No attribution of any kind: no "Generated with", no \`Co-Authored-By\`  trailer, no model, tool, gateway or provider names, and nothing that  implies the work was produced or reviewed by several agents — no "one  reviewer noted", no "multiple reviewers found". If a template, CLI or hook  adds attribution, remove it before committing or posting. Reviewer names  and model IDs stay in the terminal and never reach GitHub or Jira.`;

export const DEFAULTVERIFYTEMPLATE = `Check whether \${title} is actually live on \${env}.

It was merged into \${repo} as #\${number} — \${url}

Step 0 — read $KOVAN_TICKET. It is this ticket's file: what was asked for  in Jira's own words, the pull requests that carried it, the work already  done on it and every earlier check, with what each one concluded. Check  against what was asked, not against what the pull request says it did. If  it has been checked before, your job is partly to say what has changed  since. Do not edit that file — Kovan rebuilds it from your report, and  anything you write into it is lost.

Step 1 — work out what to look for. Read what the pull request changed:

    gh pr view \${number} --repo \${repo}
    gh pr diff \${number} --repo \${repo} --stat

Pull the full diff only for the files that stat shows changed — skip  generated or unrelated files. From the diff, write down the specific  user-visible behaviour it was supposed to produce, and where on the site  you would see it. Be concrete:  "the player controls stay pinned when you scroll a lesson", not "the  frontend was updated".

Step 2 — go and look. The site is \${site}. Drive a real browser with  Playwright and check each of those behaviours against what is actually on  screen. Do not infer the answer from the code — the whole point is that  the code being merged and the feature being live are different facts.

\${accounts}
\${basicAuth}
Screenshot everything that proves something — the feature working, or the  place it should be and is not. Save each one as a PNG in $KOVAN_SHOTS,  numbered in the order you took them and named for what they show:

    $KOVAN_SHOTS/01-signed-in.png
    $KOVAN_SHOTS/02-lesson-page-scrolled.png

Save each one the moment you take it — Kovan shows them live while you  work. Before each step, overwrite $KOVAN_STATUS with one short line  saying what you are doing, e.g.

    echo "Opening the lesson page as Teacher" > "$KOVAN_STATUS"

Each time you save a screenshot, also append its file name and the full  address of the page it shows to $KOVAN_PAGES, so Kovan can open that  exact page for me:

    echo "02-lesson-page-scrolled.png https://…/course/12/unit/3" >> "$KOVAN_PAGES"

Step 3 — write $KOVAN_REPORT. Its first line must be  exactly one of:

\${verdicts}

Under it, say what you checked, what you saw, and which screenshot shows  it. If it is not there, say what is there instead. If you could not get  far enough to tell — the site is down, the login failed, the page needs  data you do not have — say \`could not check\` and write down what stopped  you, which is a useful answer and a guess is not.`;

/**
 * The four answers an agent is asked to choose between.
 *
 * Exported and rendered into the template rather than typed into it, so a
 * fifth verdict cannot leave the prompt offering four options to something
 * that knows five. Carried over from devhub-mac unchanged: these are the
 * words already written into every report Kovan will read back.
 */
export const VERDICTS = [
  'implemented',
  'partly implemented',
  'not implemented',
  'could not check'
] as const;

/** Indented, which is how the rest of the template marks text to copy exactly. */
function verdictLines(): string {
  return VERDICTS.map((v) => `        VERDICT: ${v}`).join('\n');
}

/**
 * The extra paragraph about an HTTP Basic Auth wall, only when the
 * environment actually has one. A clause about credentials that do not exist
 * is an invitation to go looking for them.
 */
function basicAuthClause(hasBasicAuth: boolean): string {
  if (!hasBasicAuth) {
    return '';
  }
  return `
Before that sign-in page, the site itself may ask for a separate username  and password in a browser dialog — an HTTP Basic Auth wall, not the app's  own login. If you see one, answer it with the username in  $KOVAN_ENV_BASIC_USER and the password in $KOVAN_ENV_BASIC_PASSWORD, then  continue signing in to the app as above.
`;
}

export interface VerifyEnvironment {
  /** The display name the sentence reads as — "Dev", "Staging". */
  name: string;
  /** The base URL the agent is sent to. */
  site: string;
  /** Whether there is a Basic Auth wall, distinct from the app's own sign-in. */
  hasBasicAuth?: boolean;
  /**
   * Who the agent can sign in as, in the order `$KOVAN_ACCOUNT_n_*` numbers
   * them. Left out, the prompt keeps the single `$KOVAN_ENV_USER` sign-in it
   * had before accounts existed.
   */
  accounts?: readonly TestAccount[];
}

const SINGLE_SIGN_IN = `Sign in with the username in $KOVAN_ENV_USER and the password in  $KOVAN_ENV_PASSWORD. Read both from the environment. Never print them,  never echo them into a terminal, never write them into a file, a commit or  a screenshot, and do not repeat them back to me.`;

/**
 * The "check it shipped" prompt.
 *
 * Separate from `renderPullPrompt` because the verify template needs four
 * values the others do not have, and `substitute` leaves an unknown
 * placeholder alone: rendered through the general path, this template reached
 * the agent still saying "The site is ${site}", which is not a prompt, it is a
 * bug with instructions wrapped around it.
 */
export function renderVerifyPrompt(
  template: string,
  pull: PullSummary,
  environment: VerifyEnvironment,
  options: { ticketKey?: string; reviewers?: string[]; conventions?: Conventions } = {}
): string {
  // Nothing configured yet: say so in the prompt. An agent told to go and
  // look at a site nobody named should stop and say it cannot, not guess a
  // URL and report confidently on whatever answers.
  const named = environment.name.trim() || 'the environment set in Kovan';
  const site = environment.site.trim()
    || 'NOT CONFIGURED — no site is set in Kovan. Stop here and report `could not check`, saying that no environment is configured.';

  const accounts = environment.accounts
    ? verifyAccountsClause(named, environment.accounts)
    : SINGLE_SIGN_IN;
  // A template saved before `${accounts}` existed still gets told who it can
  // sign in as — at the end, rather than not at all.
  const withAccounts = template.includes('${accounts}') || !environment.accounts
    ? template
    : `${template}\n\n${accounts}`;

  return substitute(renderPullPrompt(withAccounts, pull, options), {
    env: named,
    site,
    verdicts: verdictLines(),
    basicAuth: basicAuthClause(Boolean(environment.hasBasicAuth)),
    accounts
  });
}

/** What `${state}` says when a pull request has nothing wrong with it. */
const NOTHING_BLOCKING = 'nothing — check whether it is ready to merge';

export interface Conventions {
  baseBranch: string;
  /** The commands that must pass before anything is pushed. */
  checks: string[];
  /** Files an agent must not edit. */
  untouchable: string[];
  /** Who to put on the pull request. */
  pullRequestReviewers: string[];
}

export const DEFAULT_CONVENTIONS: Conventions = {
  baseBranch: 'main',
  checks: [],
  untouchable: [],
  pullRequestReviewers: []
};

/** `a`, `a and b`, `a, b and c`. */
export function list(names: readonly string[] = []): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function checksBlock(conventions: Conventions): string {
  return !conventions.checks || conventions.checks.length === 0
    ? 'whatever this repository uses'
    : conventions.checks.map((c) => `\`${c}\``).join(', ');
}

function untouchableClause(conventions: Conventions): string {
  return !conventions.untouchable || conventions.untouchable.length === 0
    ? ''
    : `Do not edit ${list(conventions.untouchable.map((f) => `\`${f}\``))}.`;
}

/**
 * A whole clause rather than a list, because it has to disappear cleanly:
 * somebody with no reviewers configured must not be handed a prompt that says
 * "also ask  to review this".
 */
function pullRequestReviewerClause(choices: readonly string[] = []): string {
  return choices.length === 0
    ? ''
    : `Request a review from ${list(choices)} on the pull request.`;
}

function reviewBlock(reviewers: readonly string[]): string {
  return reviewers.length === 0
    ? ''
    : `Then have ${list(reviewers)} review the result, and fold in what they find.`;
}

/**
 * Substitutes `${name}` placeholders.
 *
 * An unknown placeholder is left exactly as written rather than blanked, so a
 * typo is visible instead of silently swallowed.
 */
export function substitute(template: string, values: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (whole, name: string) =>
    name in values ? values[name]! : whole
  );
}

/** The ticket key in a pull request title, e.g. `PROJ-1234`. */
export function ticketKeyInTitle(title: string, pattern = '[A-Z][A-Z0-9]+-\\d+'): string {
  return new RegExp(pattern).exec(title)?.[0] ?? '';
}

export function renderPullPrompt(
  template: string,
  pull: PullSummary,
  options: {
    ticketKey?: string;
    reviewers?: string[];
    conventions?: Conventions;
  } = {}
): string {
  // Merged rather than substituted: settings imported from an older app, or
  // hand-edited, can be missing fields, and a half-filled object here used to
  // crash the prompt rather than fall back.
  const conventions = { ...DEFAULT_CONVENTIONS, ...options.conventions };
  const flagged = describePull(pull);
  // The ticket in the title when the caller did not name one: the whole app
  // files work under a ticket where it can find one, and a prompt that does not
  // mention it sends the agent to look the work up by pull request number.
  const key = options.ticketKey || ticketKeyInTitle(pull.title);

  return substitute(template, {
    url: pull.url,
    repo: pull.repo,
    number: String(pull.number),
    title: pull.title,
    author: pull.author,
    // The row's own words for what is wrong, so the prompt says up front what
    // it is being asked to fix and matches what you were looking at.
    state: flagged === 'Open' ? NOTHING_BLOCKING : flagged,
    key,
    reviewers: reviewBlock(options.reviewers ?? []),
    checks: checksBlock(conventions),
    base: conventions.baseBranch,
    untouchable: untouchableClause(conventions),
    prReviewers: pullRequestReviewerClause(conventions.pullRequestReviewers),
    attribution: ATTRIBUTIONRULE,
    report: REPORTRULE
  });
}

export function renderIssuePrompt(
  issue: JiraIssue,
  options: {
    template?: string;
    reviewers?: string[];
    conventions?: Conventions;
  } = {}
): string {
  const conventions = { ...DEFAULT_CONVENTIONS, ...options.conventions };
  return substitute(options.template ?? DEFAULTISSUETEMPLATE, {
    key: issue.key,
    summary: issue.summary,
    description: issue.description,
    status: issue.status,
    type: issue.issueType,
    url: issue.url,
    priority: issue.priority ?? '',
    reviewers: reviewBlock(options.reviewers ?? []),
    checks: checksBlock(conventions),
    base: conventions.baseBranch,
    untouchable: untouchableClause(conventions),
    prReviewers: pullRequestReviewerClause(conventions.pullRequestReviewers),
    attribution: ATTRIBUTIONRULE,
    report: REPORTRULE
  });
}

/**
 * One line per frame. `resolvedPath` — `pathMapper.resolveFrame()`'s job, not
 * this module's — wins when there is one; the raw Sentry filename is what is
 * left when resolution failed, so a frame is never silently dropped for want
 * of a local file. A line number with no path to attach it to says nothing,
 * so it is only shown once there is a path.
 */
function frameLines(frames: readonly SentryFrame[]): string {
  if (frames.length === 0) {
    return '(no stack trace was available for the latest event)';
  }
  return frames
    .map((f, i) => {
      const tag = f.inApp ? '' : '(dependency) ';
      const path = f.resolvedPath ?? f.filename ?? '(unknown file)';
      const line = f.lineNo && (f.resolvedPath ?? f.filename) ? `:${f.lineNo}` : '';
      const fn = f.function ? ` — ${f.function}` : '';
      return `${i + 1}. ${tag}${path}${line}${fn}`;
    })
    .join('\n');
}

export const DEFAULTSENTRYTEMPLATE = `Fix the Sentry error \${shortId} — \${title}.

\${permalink}

Level: \${level} · Culprit: \${culprit} · Seen \${count} times, \${userCount} users  affected. First seen \${firstSeen}, last seen \${lastSeen}.

# Stack trace (outermost first, throw site last)

\${frames}

Investigate the actual code at each in-app frame above before assuming the  cause — the culprit line is where it surfaced, not always where it  originates. Read enough of the surrounding code and its callers to  understand why it happens, not just where.

Fix the root cause, not just this one call site, if the same mistake is  repeated elsewhere. Add or update a test that would have caught it, where  the codebase has tests for this kind of code.

Verify locally:

\${checks}

\${reviewers}
Commit referencing \${shortId} in the commit body or pull request  description — never in code comments or test names, which is  implementation, not provenance. Push the branch and open the pull request  against \${base}.\${prReviewers}

\${attribution}

\${report}`;

export function renderSentryPrompt(
  issue: SentryIssue,
  frames: readonly SentryFrame[],
  options: { template?: string; reviewers?: string[]; conventions?: Conventions } = {}
): string {
  const conventions = { ...DEFAULT_CONVENTIONS, ...options.conventions };
  return substitute(options.template ?? DEFAULTSENTRYTEMPLATE, {
    shortId: issue.shortId,
    title: issue.title,
    culprit: issue.culprit || '(unknown)',
    level: issue.level,
    count: String(issue.count),
    userCount: String(issue.userCount),
    permalink: issue.permalink,
    firstSeen: issue.firstSeen || 'unknown',
    lastSeen: issue.lastSeen || 'unknown',
    frames: frameLines(frames),
    reviewers: reviewBlock(options.reviewers ?? []),
    checks: checksBlock(conventions),
    base: conventions.baseBranch,
    prReviewers: pullRequestReviewerClause(conventions.pullRequestReviewers),
    attribution: ATTRIBUTIONRULE,
    report: REPORTRULE
  });
}
