import { describe, expect, it } from 'vitest';
import { accountPasswordKey, basicPasswordKey } from '@baton/core';
import { TestEnvironments } from '../src/main/testEnvironments';
import type { DesktopHost } from '../src/main/host';

/** Just enough of a host: a settings map and a secrets map. */
function fakeHost(settings: Record<string, unknown>, secrets: Record<string, string>) {
  const host = {
    config: {
      get: <T>(key: string, fallback: T) => (key in settings ? settings[key] as T : fallback),
      set: async (key: string, value: unknown) => { settings[key] = value; }
    },
    secrets: {
      get: async (key: string) => secrets[key],
      set: async (key: string, value: string) => { secrets[key] = value; },
      delete: async (key: string) => { delete secrets[key]; },
      has: async (key: string) => key in secrets
    },
    log: { info: () => {}, warn: () => {}, error: () => {} }
  };
  return host as unknown as DesktopHost;
}

describe('test environments', () => {
  it('turns the old single environment into Dev with one account, keeping its passwords', async () => {
    const settings: Record<string, unknown> = {
      'verify.environment': 'Staging', 'verify.site': 'https://staging.invalid', 'verify.username': 'me@x.invalid',
      'verify.basicAuth': true, 'verify.basicUsername': 'wall'
    };
    const secrets: Record<string, string> = { 'verify.password': 'pw', 'verify.basicPassword': 'wall-pw' };
    const envs = new TestEnvironments(fakeHost(settings, secrets));

    const state = await envs.state();
    expect(state.environments.map((e) => e.name)).toEqual(['Staging', 'Local']);
    expect(state.environments[0]).toMatchObject({ site: 'https://staging.invalid', basicAuth: true, basicUsername: 'wall' });
    expect(state.accounts).toHaveLength(1);
    expect(state.defaultEnvironment).toBe('dev');
    const id = state.accounts[0]!.id;
    expect(state.savedPasswords).toContain(accountPasswordKey(id));

    expect(await envs.env({})).toEqual({
      BATON_ACCOUNT_1_USER: 'me@x.invalid', BATON_ACCOUNT_1_PASSWORD: 'pw',
      BATON_ENV_USER: 'me@x.invalid', BATON_ENV_PASSWORD: 'pw',
      BATON_ENV_BASIC_USER: 'wall', BATON_ENV_BASIC_PASSWORD: 'wall-pw'
    });
    // The old keys stay, so an older build still works.
    expect(secrets['verify.password']).toBe('pw');
  });

  it('starts a fresh profile with Dev and Local and no accounts', async () => {
    const state = await new TestEnvironments(fakeHost({}, {})).state();
    expect(state.environments.map((e) => e.id)).toEqual(['dev', 'local']);
    expect(state.accounts).toEqual([]);
  });

  it('only hands a run the accounts that were ticked, and forgets a removed one', async () => {
    const secrets: Record<string, string> = {};
    const envs = new TestEnvironments(fakeHost({}, secrets));
    const { environments } = await envs.state();
    const accounts = [
      { id: 'a1', environmentId: 'local', label: 'Student', role: 'student', segment: 'b2c' as const, username: 's', notes: '' },
      { id: 'a2', environmentId: 'local', label: 'Teacher', role: 'teacher', segment: 'b2b' as const, username: 't', notes: '' }
    ];
    await envs.save({
      environments, accounts, defaultEnvironment: 'local',
      passwords: { [accountPasswordKey('a1')]: 'p1', [accountPasswordKey('a2')]: 'p2', [basicPasswordKey('local')]: '' }
    });

    const onlyTeacher = await envs.env({ environmentId: 'local', accountIds: ['a2'] });
    expect(onlyTeacher).toEqual({
      BATON_ACCOUNT_1_USER: 't', BATON_ACCOUNT_1_PASSWORD: 'p2', BATON_ENV_USER: 't', BATON_ENV_PASSWORD: 'p2'
    });
    expect(await envs.env({ environmentId: 'dev' })).toEqual({});

    await envs.save({ environments, accounts: [accounts[1]!], defaultEnvironment: 'local', passwords: {} });
    expect(secrets[accountPasswordKey('a1')]).toBeUndefined();
    expect(secrets[accountPasswordKey('a2')]).toBe('p2');
  });

  it('uses a URL typed into the run sheet for that run only', async () => {
    const envs = new TestEnvironments(fakeHost({}, {}));
    const typed = await envs.resolve({ environmentId: 'local', site: ' http://localhost:5173 ' });
    expect(typed?.environment.site).toBe('http://localhost:5173');
    const saved = await envs.resolve({ environmentId: 'local' });
    expect(saved?.environment.site).toBe('http://localhost:3000');
  });
});
