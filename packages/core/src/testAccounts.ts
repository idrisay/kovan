/**
 * The environments an agent can be sent to look at — Dev, your local build,
 * anything else — and the test accounts it can sign in with on each.
 *
 * A product with students, teachers and parents, each of them B2C or B2B,
 * cannot be checked with one login: the behaviour a ticket changes is often
 * only visible to one of them. So an environment carries a list of accounts,
 * each labelled with who it is, and the agent is told which exist and asked
 * to use the one the change affects.
 *
 * Nothing here is a secret. Passwords live in the SecretStore under
 * `accountPasswordKey` / `basicPasswordKey`, the same way a provider token
 * does, and reach the agent only as environment variables — the prompt names
 * the variable, never the value.
 */

export type AccountSegment = '' | 'b2c' | 'b2b';

export interface TestEnvironment {
  id: string;
  /** What the prompt calls it — "Dev", "Local". */
  name: string;
  /** Base URL the agent opens. */
  site: string;
  /** An HTTP Basic Auth wall in front of the app's own sign-in. */
  basicAuth: boolean;
  basicUsername: string;
}

export interface TestAccount {
  id: string;
  environmentId: string;
  /** Free text, so "Teacher — two classes" is as easy as "Teacher". */
  label: string;
  /** Who this account is: student, teacher, parent… */
  role: string;
  segment: AccountSegment;
  username: string;
  /** Anything the agent should know: "has an expired subscription". */
  notes: string;
}

/** Offered in the role field; anything else can be typed. */
export const ACCOUNT_ROLE_SUGGESTIONS = ['student', 'teacher', 'parent', 'school admin', 'admin'] as const;

export const SEGMENT_LABEL: Record<AccountSegment, string> = { '': '', b2c: 'B2C', b2b: 'B2B' };

export const accountPasswordKey = (accountId: string) => `testAccount.${accountId}.password`;
export const basicPasswordKey = (environmentId: string) => `testEnv.${environmentId}.basicPassword`;

/** The two a fresh profile starts with: the item that asked for this named both. */
export const DEFAULT_ENVIRONMENTS: TestEnvironment[] = [
  { id: 'dev', name: 'Dev', site: '', basicAuth: false, basicUsername: '' },
  { id: 'local', name: 'Local', site: 'http://localhost:3000', basicAuth: false, basicUsername: '' }
];

/** "Teacher · B2B", or whatever of that the account has. */
export function describeAccount(account: Pick<TestAccount, 'label' | 'role' | 'segment'>): string {
  const role = account.role.trim();
  const label = account.label.trim();
  const who = label && role && label.toLowerCase() !== role.toLowerCase()
    ? `${label} (${role})`
    : label || role || 'Account';
  const segment = SEGMENT_LABEL[account.segment];
  return segment ? `${who} · ${segment}` : who;
}

/** `$KOVAN_ACCOUNT_2_USER` — numbered in the order the prompt lists them. */
export function accountVar(index: number, part: 'USER' | 'PASSWORD'): string {
  return `KOVAN_ACCOUNT_${index + 1}_${part}`;
}

/**
 * The environment variables for a run: one numbered pair per account, plus
 * the first account again under the original `$KOVAN_ENV_USER` /
 * `$KOVAN_ENV_PASSWORD` names, so a verify template written before accounts
 * existed still signs in with something.
 */
export function accountEnvVars(
  accounts: readonly TestAccount[],
  passwords: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const vars: Record<string, string> = {};
  accounts.forEach((account, i) => {
    const password = passwords[account.id];
    if (account.username) vars[accountVar(i, 'USER')] = account.username;
    if (password) vars[accountVar(i, 'PASSWORD')] = password;
  });
  const first = accounts[0];
  if (first?.username) vars['KOVAN_ENV_USER'] = first.username;
  if (first && passwords[first.id]) vars['KOVAN_ENV_PASSWORD'] = passwords[first.id]!;
  return vars;
}

const NEVER_LEAK =
  'Read them from the environment. Never print them, never echo them into a terminal, never write them into a file, a commit or a screenshot, and do not repeat them back to me.';

function accountLines(accounts: readonly TestAccount[]): string {
  return accounts
    .map((a, i) => {
      const notes = a.notes.trim() ? ` — ${a.notes.trim()}` : '';
      return `    ${i + 1}. ${describeAccount(a)}${notes}: username in $${accountVar(i, 'USER')}, password in $${accountVar(i, 'PASSWORD')}`;
    })
    .join('\n');
}

/**
 * The sign-in paragraph of the verify prompt. With several accounts the agent
 * picks the ones the change is about — a teacher-only feature checked while
 * signed in as a student would honestly report "not implemented".
 */
export function verifyAccountsClause(environmentName: string, accounts: readonly TestAccount[]): string {
  if (accounts.length === 0) {
    return `No test account is set up for ${environmentName} in Kovan. If what you need to check is behind a sign-in, stop and report \`could not check\`, saying that no account is configured — do not sign up or guess one.`;
  }
  if (accounts.length === 1) {
    return `Sign in as ${describeAccount(accounts[0]!)}, with the username in $${accountVar(0, 'USER')} and the password in $${accountVar(0, 'PASSWORD')}. ${NEVER_LEAK}`;
  }
  return `These test accounts exist on ${environmentName}. Sign in as the one the change is about; where the behaviour should differ by role or between B2B and B2C, check each account it concerns, and say in the report which account each finding came from.

${accountLines(accounts)}

${NEVER_LEAK}`;
}

/**
 * Appended to an implement / unblock / Sentry prompt when the run sheet picks
 * an environment to test on. Short on purpose: the agent already has its own
 * "verify locally" step, this only tells it where and as whom.
 */
export function testingClause(environment: TestEnvironment, accounts: readonly TestAccount[]): string {
  const site = environment.site.trim() || '(no URL set in Kovan — find it from the repository)';
  const lines = [
    '## Where to check it in a browser',
    '',
    `When you check your change in a real browser, use ${environment.name} at ${site}.`
  ];
  if (accounts.length > 0) {
    lines.push(
      'Sign in as whichever of these test accounts the change affects — more than one if it behaves differently by role or between B2B and B2C:',
      '',
      accountLines(accounts),
      '',
      NEVER_LEAK
    );
  } else {
    lines.push(`No test account is set up for ${environment.name} in Kovan; if a check needs one, say so rather than creating one.`);
  }
  if (environment.basicAuth) {
    lines.push(
      '',
      'The site may first ask for a separate HTTP Basic Auth username and password in a browser dialog: use $KOVAN_ENV_BASIC_USER and $KOVAN_ENV_BASIC_PASSWORD.'
    );
  }
  return lines.join('\n');
}

/** A short id that is stable once saved and never collides in practice. */
export function newTestId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
