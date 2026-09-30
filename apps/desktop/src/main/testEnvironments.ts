import {
  DEFAULT_ENVIRONMENTS, accountEnvVars, accountPasswordKey, basicPasswordKey, newTestId,
  type TestAccount, type TestEnvironment
} from '@kovan/core';
import type { DesktopHost } from './host';

/** What Settings and the run sheet see: no passwords, only whether one is saved. */
export interface TestEnvironmentState {
  environments: TestEnvironment[];
  accounts: TestAccount[];
  defaultEnvironment: string;
  /** Secret keys (`accountPasswordKey`, `basicPasswordKey`) that hold a value. */
  savedPasswords: string[];
}

export interface TestEnvironmentSave {
  environments: TestEnvironment[];
  accounts: TestAccount[];
  defaultEnvironment: string;
  /** Only the passwords typed this time, by secret key. Blank means "keep". */
  passwords: Record<string, string>;
}

/** Which environment and accounts a run was started with. */
export interface TestSelection {
  environmentId?: string;
  /** Unset means every account on the environment. */
  accountIds?: string[];
  /** A URL typed into the run sheet for this run only — a different port, a preview deploy. */
  site?: string;
}

/**
 * The environments an agent can be sent to and the accounts it signs in
 * with. Settings, not state: the list is edited in Settings and read at the
 * moment a run starts, so a password changed a minute ago is the one used.
 */
export class TestEnvironments {
  constructor(private readonly host: DesktopHost) {}

  /**
   * The single environment Kovan had before this — `verify.site`,
   * `verify.username` and friends — becomes the first entry the first time
   * anything asks, with its username as one account and its passwords copied
   * to the new keys. The old keys are left where they were, so going back to
   * an older build loses nothing. Cheap to ask every time: once there is a
   * list (and Settings never lets the last environment go) it returns at once.
   */
  private async migrate(): Promise<void> {
    if (this.host.config.get<TestEnvironment[]>('verify.environments', []).length > 0) return;

    const environments = DEFAULT_ENVIRONMENTS.map((e) => ({ ...e }));
    const accounts: TestAccount[] = [];
    const dev = environments[0]!;
    const legacySite = this.host.config.get('verify.site', '');
    if (legacySite) {
      dev.name = this.host.config.get('verify.environment', '') || dev.name;
      dev.site = legacySite;
      dev.basicAuth = this.host.config.get('verify.basicAuth', false);
      dev.basicUsername = this.host.config.get('verify.basicUsername', '');
      const basic = await this.host.secrets.get('verify.basicPassword');
      if (basic) await this.host.secrets.set(basicPasswordKey(dev.id), basic);

      const username = this.host.config.get('verify.username', '');
      if (username) {
        const account: TestAccount = {
          id: newTestId('acct'), environmentId: dev.id,
          label: 'Default', role: '', segment: '', username, notes: ''
        };
        accounts.push(account);
        const password = await this.host.secrets.get('verify.password');
        if (password) await this.host.secrets.set(accountPasswordKey(account.id), password);
      }
    }
    await this.host.config.set('verify.environments', environments);
    await this.host.config.set('verify.accounts', accounts);
    await this.host.config.set('verify.defaultEnvironment', dev.id);
    this.host.log.info(`test environments: seeded ${environments.length}, migrated ${accounts.length} account(s)`);
  }

  async state(): Promise<TestEnvironmentState> {
    await this.migrate();
    const environments = this.host.config.get<TestEnvironment[]>('verify.environments', []);
    const accounts = this.host.config.get<TestAccount[]>('verify.accounts', []);
    const keys = [
      ...accounts.map((a) => accountPasswordKey(a.id)),
      ...environments.filter((e) => e.basicAuth).map((e) => basicPasswordKey(e.id))
    ];
    const savedPasswords: string[] = [];
    for (const key of keys) {
      if (await this.host.secrets.has(key)) savedPasswords.push(key);
    }
    return {
      environments,
      accounts,
      defaultEnvironment: this.host.config.get('verify.defaultEnvironment', '') || environments[0]?.id || '',
      savedPasswords
    };
  }

  async save(next: TestEnvironmentSave): Promise<TestEnvironmentState> {
    await this.migrate();
    const before = this.host.config.get<TestAccount[]>('verify.accounts', []);
    const beforeEnvs = this.host.config.get<TestEnvironment[]>('verify.environments', []);
    const envIds = new Set(next.environments.map((e) => e.id));
    // An account whose environment was removed goes with it.
    const accounts = next.accounts.filter((a) => envIds.has(a.environmentId));

    for (const [key, value] of Object.entries(next.passwords)) {
      if (value) await this.host.secrets.set(key, value);
    }
    // A removed account's password is not left behind in the Keychain.
    const kept = new Set(accounts.map((a) => a.id));
    for (const gone of before.filter((a) => !kept.has(a.id))) {
      await this.host.secrets.delete(accountPasswordKey(gone.id));
    }
    for (const gone of beforeEnvs.filter((e) => !envIds.has(e.id))) {
      await this.host.secrets.delete(basicPasswordKey(gone.id));
    }

    await this.host.config.set('verify.environments', next.environments);
    await this.host.config.set('verify.accounts', accounts);
    await this.host.config.set(
      'verify.defaultEnvironment',
      envIds.has(next.defaultEnvironment) ? next.defaultEnvironment : next.environments[0]?.id ?? ''
    );
    return this.state();
  }

  /** The environment and its chosen accounts, in prompt order. */
  async resolve(selection: TestSelection): Promise<{ environment: TestEnvironment; accounts: TestAccount[] } | undefined> {
    const { environments, accounts, defaultEnvironment } = await this.state();
    const environment = environments.find((e) => e.id === (selection.environmentId ?? defaultEnvironment));
    if (!environment) return undefined;
    const site = selection.site?.trim();
    const effective = site ? { ...environment, site } : environment;
    const onEnv = accounts.filter((a) => a.environmentId === environment.id);
    const chosen = selection.accountIds ? onEnv.filter((a) => selection.accountIds!.includes(a.id)) : onEnv;
    return { environment: effective, accounts: chosen };
  }

  /**
   * The environment variables a run gets: numbered account credentials and
   * the Basic Auth pair. Handed to the agent's process only — never written
   * into the prompt, which names the variables and nothing else.
   */
  async env(selection: TestSelection): Promise<Record<string, string>> {
    const resolved = await this.resolve(selection);
    if (!resolved) return {};
    const passwords: Record<string, string | undefined> = {};
    for (const account of resolved.accounts) {
      passwords[account.id] = await this.host.secrets.get(accountPasswordKey(account.id));
    }
    const vars = accountEnvVars(resolved.accounts, passwords);
    if (resolved.environment.basicAuth) {
      const basicPassword = await this.host.secrets.get(basicPasswordKey(resolved.environment.id));
      if (resolved.environment.basicUsername) vars['KOVAN_ENV_BASIC_USER'] = resolved.environment.basicUsername;
      if (basicPassword) vars['KOVAN_ENV_BASIC_PASSWORD'] = basicPassword;
    }
    return vars;
  }
}
