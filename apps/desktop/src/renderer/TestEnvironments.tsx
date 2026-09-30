import { useEffect, useMemo, useState } from 'react';
import {
  ACCOUNT_ROLE_SUGGESTIONS, accountPasswordKey, basicPasswordKey, describeAccount, newTestId,
  type AccountSegment, type TestAccount, type TestEnvironment
} from '@kovan/core';
import type { RunKind, TestEnvironmentState, TestSelection } from './types';

/**
 * Settings → Environments: every place an agent can be sent to look (Dev,
 * your local build, anything else), and the test accounts on each — a
 * student, a teacher, a parent, B2C or B2B — so a check can sign in as the
 * person the change is actually for.
 *
 * Everything is edited as a draft and written on Save. Passwords go to the
 * Keychain and never come back to this window; a field shows "saved" instead.
 */
export function TestEnvironmentSettings() {
  const [state, setState] = useState<TestEnvironmentState>();
  const [environments, setEnvironments] = useState<TestEnvironment[]>([]);
  const [accounts, setAccounts] = useState<TestAccount[]>([]);
  const [defaultEnvironment, setDefaultEnvironment] = useState('');
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [active, setActive] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string }>();

  const load = (next: TestEnvironmentState) => {
    setState(next);
    setEnvironments(next.environments);
    setAccounts(next.accounts);
    setDefaultEnvironment(next.defaultEnvironment);
    setPasswords({});
    setActive((current) => (next.environments.some((e) => e.id === current) ? current : next.environments[0]?.id ?? ''));
  };
  useEffect(() => { void window.kovan.testEnvironments().then(load); }, []);

  const env = environments.find((e) => e.id === active);
  const envAccounts = accounts.filter((a) => a.environmentId === active);
  const saved = new Set(state?.savedPasswords ?? []);
  const dirty = useMemo(() => Boolean(state) && (
    JSON.stringify(state!.environments) !== JSON.stringify(environments) ||
    JSON.stringify(state!.accounts) !== JSON.stringify(accounts) ||
    state!.defaultEnvironment !== defaultEnvironment ||
    Object.values(passwords).some(Boolean)
  ), [state, environments, accounts, defaultEnvironment, passwords]);

  const patchEnv = (patch: Partial<TestEnvironment>) =>
    setEnvironments((list) => list.map((e) => (e.id === active ? { ...e, ...patch } : e)));
  const patchAccount = (id: string, patch: Partial<TestAccount>) =>
    setAccounts((list) => list.map((a) => (a.id === id ? { ...a, ...patch } : a)));

  function addEnvironment() {
    const id = newTestId('env');
    setEnvironments((list) => [...list, { id, name: `Environment ${list.length + 1}`, site: '', basicAuth: false, basicUsername: '' }]);
    setActive(id);
    setConfirmRemove(false);
  }

  function addAccount() {
    setAccounts((list) => [...list, {
      id: newTestId('acct'), environmentId: active, label: '', role: '', segment: '', username: '', notes: ''
    }]);
  }

  async function save() {
    setSaving(true);
    setNote(undefined);
    try {
      load(await window.kovan.testEnvironmentsSave({ environments, accounts, defaultEnvironment, passwords }));
      setNote({ ok: true, text: 'Saved.' });
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : 'Save failed.' });
    } finally {
      setSaving(false);
    }
  }

  const passwordPlaceholder = (key: string) =>
    saved.has(key) ? 'Saved — type to replace' : 'Not set';

  if (!state) return <p className="quiet">Loading…</p>;

  return (
    <section className="provider test-envs">
      <h3>Environments</h3>
      <p className="settings-note">
        Where agents check their work, and who they sign in as. "Check it shipped" picks one of these; "Work on this" and
        "Unblock" can too, to test in a browser. Passwords reach the agent only as environment variables, never in the
        prompt.
      </p>
      <div className="theme-picker env-picker" role="tablist" aria-label="Environments">
        {environments.map((e) => (
          <button
            key={e.id} type="button" role="tab" aria-selected={e.id === active}
            className={e.id === active ? 'active' : ''}
            onClick={() => { setActive(e.id); setConfirmRemove(false); }}
          >
            {e.name || 'Unnamed'}
            {e.id === defaultEnvironment && <span className="env-default-dot" title="Default for Check it shipped" />}
          </button>
        ))}
        <button type="button" className="env-add" onClick={addEnvironment} aria-label="Add environment">+ Add</button>
      </div>

      {env && (
        <>
          <div className="env-grid">
            <label>
              <span>Name</span>
              <input value={env.name} onChange={(e) => patchEnv({ name: e.target.value })} placeholder="Dev" />
            </label>
            <label>
              <span>Site URL</span>
              <input
                value={env.site} onChange={(e) => patchEnv({ site: e.target.value })}
                placeholder="https://dev.example.com" spellCheck={false}
              />
            </label>
          </div>
          <label className="checkbox-row">
            <input
              type="checkbox" checked={defaultEnvironment === env.id}
              onChange={(e) => e.target.checked && setDefaultEnvironment(env.id)}
            />
            <span>Default for "Check it shipped"</span>
          </label>
          <label className="checkbox-row">
            <input type="checkbox" checked={env.basicAuth} onChange={(e) => patchEnv({ basicAuth: e.target.checked })} />
            <span>Site sits behind a separate HTTP Basic Auth wall</span>
          </label>
          {env.basicAuth && (
            <div className="env-grid">
              <label>
                <span>Basic auth username</span>
                <input value={env.basicUsername} onChange={(e) => patchEnv({ basicUsername: e.target.value })} />
              </label>
              <label>
                <span>Basic auth password</span>
                <input
                  type="password" value={passwords[basicPasswordKey(env.id)] ?? ''}
                  placeholder={passwordPlaceholder(basicPasswordKey(env.id))}
                  onChange={(e) => setPasswords((p) => ({ ...p, [basicPasswordKey(env.id)]: e.target.value }))}
                />
              </label>
            </div>
          )}

          <h3>Accounts on {env.name || 'this environment'} <span className="env-count">{envAccounts.length}</span></h3>
          {envAccounts.length === 0 && (
            <p className="settings-note">No accounts yet. Add one per person you test as — a B2C student, a B2B teacher, a parent…</p>
          )}
          <datalist id="account-roles">
            {ACCOUNT_ROLE_SUGGESTIONS.map((r) => <option key={r} value={r} />)}
          </datalist>
          <ul className="account-list">
            {envAccounts.map((a) => (
              <li key={a.id} className="account-card">
                <div className="account-row">
                  <label>
                    <span>Name</span>
                    <input value={a.label} placeholder="Student with two courses" onChange={(e) => patchAccount(a.id, { label: e.target.value })} />
                  </label>
                  <label className="account-role">
                    <span>Role</span>
                    <input list="account-roles" value={a.role} placeholder="student" onChange={(e) => patchAccount(a.id, { role: e.target.value })} />
                  </label>
                  <label className="account-segment">
                    <span>Type</span>
                    <select value={a.segment} onChange={(e) => patchAccount(a.id, { segment: e.target.value as AccountSegment })}>
                      <option value="">—</option>
                      <option value="b2c">B2C</option>
                      <option value="b2b">B2B</option>
                    </select>
                  </label>
                </div>
                <div className="account-row">
                  <label>
                    <span>Username or email</span>
                    <input value={a.username} spellCheck={false} onChange={(e) => patchAccount(a.id, { username: e.target.value })} />
                  </label>
                  <label>
                    <span>Password</span>
                    <input
                      type="password" value={passwords[accountPasswordKey(a.id)] ?? ''}
                      placeholder={passwordPlaceholder(accountPasswordKey(a.id))}
                      onChange={(e) => setPasswords((p) => ({ ...p, [accountPasswordKey(a.id)]: e.target.value }))}
                    />
                  </label>
                </div>
                <div className="account-row">
                  <label>
                    <span>Notes for the agent (optional)</span>
                    <input value={a.notes} placeholder="Has an expired subscription" onChange={(e) => patchAccount(a.id, { notes: e.target.value })} />
                  </label>
                  <button
                    type="button" className="link account-remove"
                    onClick={() => setAccounts((list) => list.filter((x) => x.id !== a.id))}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <div className="quick-test-row">
            <button type="button" className="ghost" onClick={addAccount}>Add account</button>
            {environments.length > 1 && (confirmRemove ? (
              <span className="env-confirm">
                Remove {env.name || 'this environment'} and its {envAccounts.length} account{envAccounts.length === 1 ? '' : 's'}?
                <button
                  type="button" className="link danger"
                  onClick={() => {
                    setEnvironments((list) => list.filter((e) => e.id !== env.id));
                    setAccounts((list) => list.filter((a) => a.environmentId !== env.id));
                    setActive(environments.find((e) => e.id !== env.id)?.id ?? '');
                    setConfirmRemove(false);
                  }}
                >
                  Remove
                </button>
                <button type="button" className="link" onClick={() => setConfirmRemove(false)}>Keep</button>
              </span>
            ) : (
              <button type="button" className="link" onClick={() => setConfirmRemove(true)}>Remove environment</button>
            ))}
          </div>
        </>
      )}

      <div className="quick-test-row env-save">
        <button className="primary" disabled={saving || !dirty} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save environments'}
        </button>
        {dirty && !saving && <span className="settings-note">Unsaved changes — removals take effect on Save.</span>}
        {!dirty && note && <span className={note.ok ? 'settings-note ok' : 'settings-note error'}>{note.text}</span>}
      </div>
    </section>
  );
}

const PICK_KEY = 'kovan.test-env-pick';

/** What the last run of each kind tested on, so the sheet opens where you left it. */
function rememberedPick(kind: RunKind): string | undefined {
  try {
    return (JSON.parse(localStorage.getItem(PICK_KEY) ?? '{}') as Record<string, string>)[kind];
  } catch {
    return undefined;
  }
}

/** Item 94: the accounts you unticked on each environment, so they stay unticked. */
const UNTICKED_KEY = 'kovan.test-env-unticked';

function rememberedUnticked(environmentId: string): string[] {
  try {
    const all = JSON.parse(localStorage.getItem(UNTICKED_KEY) ?? '{}') as Record<string, unknown>;
    const list = all[environmentId];
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function rememberUnticked(environmentId: string, unticked: ReadonlySet<string>) {
  try {
    const all = JSON.parse(localStorage.getItem(UNTICKED_KEY) ?? '{}') as Record<string, string[]>;
    localStorage.setItem(UNTICKED_KEY, JSON.stringify({ ...all, [environmentId]: [...unticked] }));
  } catch { /* a convenience, not a requirement */ }
}

export function rememberPick(kind: RunKind, environmentId: string) {
  try {
    const all = JSON.parse(localStorage.getItem(PICK_KEY) ?? '{}') as Record<string, string>;
    localStorage.setItem(PICK_KEY, JSON.stringify({ ...all, [kind]: environmentId }));
  } catch { /* a convenience, not a requirement */ }
}

/**
 * The run sheet's "where, and as whom". Verify always checks somewhere, so it
 * has no "None"; the other kinds default to None and remember what you
 * picked last. Accounts start all ticked: the agent is told to use the ones
 * the change concerns, and unticking one keeps it out of the prompt and the
 * environment entirely.
 */
export function TestEnvironmentPicker({
  kind, onChange
}: {
  kind: RunKind;
  onChange: (selection: TestSelection | undefined) => void;
}) {
  const [state, setState] = useState<TestEnvironmentState>();
  const [environmentId, setEnvironmentId] = useState('');
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  // The URL as typed for this run; `site` is what the prompt was last built with.
  const [siteDraft, setSiteDraft] = useState('');
  const [site, setSite] = useState('');
  const [savingSite, setSavingSite] = useState(false);
  const required = kind === 'verify';

  useEffect(() => {
    void window.kovan.testEnvironments().then((s) => {
      setState(s);
      const remembered = rememberedPick(kind);
      const valid = (id?: string) => Boolean(id) && s.environments.some((e) => e.id === id);
      setEnvironmentId(
        required
          ? (valid(remembered) ? remembered! : s.defaultEnvironment)
          : (valid(remembered) ? remembered! : '')
      );
    });
  }, [kind, required]);

  const accounts = state?.accounts.filter((a) => a.environmentId === environmentId) ?? [];
  const accountKey = accounts.map((a) => a.id).join(',');
  const chosenCount = accounts.filter((a) => !unticked.has(a.id)).length;
  const [showAccounts, setShowAccounts] = useState(false);
  const savedSite = state?.environments.find((e) => e.id === environmentId)?.site ?? '';

  // A fresh environment starts from its saved URL.
  useEffect(() => {
    setSiteDraft(savedSite);
    setSite(savedSite);
  }, [environmentId, savedSite]);

  // …and with the accounts you left unticked on it last time (item 94).
  useEffect(() => {
    setUnticked(new Set(environmentId ? rememberedUnticked(environmentId) : []));
  }, [environmentId]);

  // Typing is debounced into the prompt rather than rebuilding it per keystroke.
  useEffect(() => {
    if (siteDraft === site) return undefined;
    const timer = setTimeout(() => setSite(siteDraft), 400);
    return () => clearTimeout(timer);
  }, [siteDraft, site]);

  async function saveSite() {
    if (!state) return;
    setSavingSite(true);
    try {
      setState(await window.kovan.testEnvironmentsSave({
        environments: state.environments.map((e) => (e.id === environmentId ? { ...e, site: siteDraft.trim() } : e)),
        accounts: state.accounts,
        defaultEnvironment: state.defaultEnvironment,
        passwords: {}
      }));
    } finally {
      setSavingSite(false);
    }
  }

  useEffect(() => {
    if (!state) return;
    if (!environmentId) { onChange(undefined); return; }
    const chosen = accounts.filter((a) => !unticked.has(a.id)).map((a) => a.id);
    const override = site.trim() && site.trim() !== savedSite ? site.trim() : undefined;
    onChange({ environmentId, accountIds: chosen, site: override });
    // `accounts` is derived from these; `onChange` is the parent's setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, environmentId, accountKey, unticked, site, savedSite]);

  if (!state) return null;
  if (state.environments.length === 0) {
    return required ? <p className="settings-note error">No environment set up. Add one in Settings → Environments.</p> : null;
  }

  const environment = state.environments.find((e) => e.id === environmentId);
  return (
    <div className="run-test-env">
      <div className="run-test-env-head">
        <span className="run-test-env-label">{required ? 'Check on' : 'Test in a browser on'}</span>
        <div className="theme-picker env-picker" role="radiogroup" aria-label="Environment">
          {!required && (
            <button
              type="button" role="radio" aria-checked={!environmentId}
              className={!environmentId ? 'active' : ''}
              onClick={() => { setEnvironmentId(''); rememberPick(kind, ''); }}
            >
              None
            </button>
          )}
          {state.environments.map((e) => (
            <button
              key={e.id} type="button" role="radio" aria-checked={e.id === environmentId}
              className={e.id === environmentId ? 'active' : ''}
              onClick={() => { setEnvironmentId(e.id); rememberPick(kind, e.id); }}
            >
              {e.name || 'Unnamed'}
            </button>
          ))}
        </div>
        {environment && (
          <input
            className="run-test-env-site"
            aria-label={`${environment.name} URL for this run`}
            value={siteDraft}
            placeholder="https://… — no URL set"
            spellCheck={false}
            onChange={(e) => setSiteDraft(e.target.value)}
            onBlur={() => setSite(siteDraft)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setSite(siteDraft); } }}
          />
        )}
        {environment && /^https?:\/\/\S+$/i.test(siteDraft.trim()) && (
          // Item 90 (D): look at it yourself, in your own browser.
          <button
            type="button" className="link run-test-env-open"
            title={`Open ${siteDraft.trim()} in your default browser`}
            onClick={() => void window.kovan.openExternal(siteDraft.trim())}
          >
            Open
          </button>
        )}
        {environment && siteDraft.trim() !== savedSite && siteDraft.trim() && (
          <button
            type="button" className="link" disabled={savingSite}
            title={`Keep ${siteDraft.trim()} as ${environment.name}'s URL`}
            onClick={() => void saveSite()}
          >
            {savingSite ? 'Saving…' : 'Save as default'}
          </button>
        )}
      </div>
      {environment && (
        accounts.length === 0 ? (
          <p className="settings-note">No accounts on {environment.name}. Add them in Settings → Environments.</p>
        ) : !showAccounts ? (
          // Item 117: one line until you want to change it; the full list of
          // checkboxes took three rows of the run sheet every time.
          <div className="run-test-accounts-summary">
            <span className="run-test-accounts-count">
              {chosenCount === accounts.length ? `All ${accounts.length} accounts` : `${chosenCount} of ${accounts.length} accounts`}
            </span>
            <span className="run-test-accounts-names" title={accounts.filter((a) => !unticked.has(a.id)).map(describeAccount).join('\n')}>
              {accounts.filter((a) => !unticked.has(a.id)).map((a) => a.role || a.label || a.username.split('@')[0]).join(' · ')}
            </span>
            <button type="button" className="link" onClick={() => setShowAccounts(true)}>Change</button>
          </div>
        ) : (
          <div className="run-test-accounts" role="group" aria-label="Accounts">
            {accounts.map((a) => (
              <label key={a.id} className="checkbox-row" title={a.notes || undefined}>
                <input
                  type="checkbox" checked={!unticked.has(a.id)}
                  onChange={(e) => setUnticked((set) => {
                    const next = new Set(set);
                    if (e.target.checked) next.delete(a.id); else next.add(a.id);
                    rememberUnticked(environmentId, next);
                    return next;
                  })}
                />
                <span>{describeAccount(a)}</span>
              </label>
            ))}
          </div>
        )
      )}
    </div>
  );
}
