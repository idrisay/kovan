import { useEffect, useState } from 'react';
import type { ProviderId } from '@baton/core';
import type { ThemeChoice } from './types';

interface Field {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
}

const PROVIDER_LABEL: Record<string, string> = {
  github: 'GitHub',
  jira: 'Jira',
  sentry: 'Sentry',
  grafana: 'Grafana',
  figma: 'Figma'
};

const THEME_OPTIONS: { id: ThemeChoice; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' }
];

/**
 * The dev environment "Check it shipped" signs an agent into — one site, its
 * own login, and an optional Basic Auth wall in front of it. Shaped as a
 * `Field[]` on purpose: it reuses the exact save path a provider does, values
 * to settings, secrets to the Keychain, nothing read back once it is secret.
 */
const ENVIRONMENT_FIELDS: Field[] = [
  { key: 'verify.environment', label: 'Environment name', placeholder: 'Staging' },
  { key: 'verify.site', label: 'Site URL', placeholder: 'https://staging.acme.app' },
  { key: 'verify.username', label: 'Username or email' },
  { key: 'verify.password', label: 'Password', secret: true }
];

const BASIC_AUTH_FIELDS: Field[] = [
  { key: 'verify.basicUsername', label: 'Basic auth username' },
  { key: 'verify.basicPassword', label: 'Basic auth password', secret: true }
];

/**
 * Not a `CREDENTIAL_FIELDS` entry: reading and searching Jira tickets — the
 * connection this app has had since the start — needs none of this, only
 * "Create ticket" from a Sentry error does. Gating "connected" on a field
 * only one new feature needs would tell an existing, working Jira connection
 * it is not connected until it also thinks about which project a bug report
 * belongs in.
 */
const JIRA_EXTRA_FIELDS: Field[] = [
  { key: 'jira.projectKey', label: 'Default project for new tickets', placeholder: 'PROJ' }
];

/**
 * One sectioned settings sheet — appearance, each connected provider, and the
 * dev environment an agent signs into — replacing what used to be a single
 * "Connections" list. Ported in spirit from DevHub's `SettingsView.swift`
 * (sidebar of sections, detail pane on the right), not literally: this is a
 * modal sheet, not a window, and the fields below are exactly what Baton's
 * prompts already know how to use.
 */
export function Settings({
  onClose,
  connected,
  theme,
  onThemeChange
}: {
  onClose: () => void;
  connected: ProviderId[];
  theme: ThemeChoice;
  onThemeChange: (choice: ThemeChoice) => void;
}) {
  const [fields, setFields] = useState<Record<string, Field[]>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [launchAtLogin, setLaunchAtLogin] = useState(false);
  const [notify, setNotify] = useState(true);
  const [basicAuth, setBasicAuth] = useState(false);
  const [saving, setSaving] = useState('');
  const [active, setActive] = useState('general');

  useEffect(() => {
    void window.baton.credentialFields().then(setFields);
    void window.baton.settings().then((settings) => {
      const seed: Record<string, string> = {};
      for (const [key, value] of Object.entries(settings)) {
        if (typeof value === 'string') {
          seed[key] = value;
        }
      }
      setValues(seed);
      setLaunchAtLogin(Boolean(settings['launchAtLogin']));
      setNotify(settings['notify.enabled'] !== false);
      setBasicAuth(Boolean(settings['verify.basicAuth']));
    });
  }, []);

  async function save(list: Field[], section: string) {
    setSaving(section);
    try {
      for (const field of list) {
        const value = values[field.key] ?? '';
        if (!value) {
          continue;
        }
        // Secrets go to the Keychain via safeStorage, settings to disk. The
        // renderer never reads either back.
        await (field.secret
          ? window.baton.setSecret(field.key, value)
          : window.baton.setSetting(field.key, value));
      }
    } finally {
      setSaving('');
    }
  }

  async function toggle(key: string, value: boolean, apply: (v: boolean) => void) {
    apply(value);
    await window.baton.setSetting(key, value);
  }

  function field(f: Field) {
    return (
      <label key={f.key}>
        <span>{f.label}</span>
        <input
          type={f.secret ? 'password' : 'text'}
          placeholder={f.placeholder ?? ''}
          value={values[f.key] ?? ''}
          onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
        />
      </label>
    );
  }

  const sections = ['general', ...Object.keys(fields), 'environment'];
  const configured = Boolean(values['verify.site']);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet settings" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2>Settings</h2>
          <button className="ghost" onClick={onClose}>
            Done
          </button>
        </header>

        <div className="settings-layout">
          <nav className="settings-nav">
            {sections.map((id) => (
              <button
                key={id}
                className={id === active ? 'active' : ''}
                onClick={() => setActive(id)}
              >
                {id === 'general' ? 'General' : id === 'environment' ? 'Dev environment' : PROVIDER_LABEL[id] ?? id}
                {id !== 'general' && id !== 'environment' && connected.includes(id as ProviderId) && (
                  <span className="badge">connected</span>
                )}
                {id === 'environment' && configured && <span className="badge">configured</span>}
              </button>
            ))}
          </nav>

          <div className="settings-body">
            {active === 'general' && (
              <section className="provider">
                <h3>Appearance</h3>
                <label>
                  <span>Theme</span>
                  <div className="theme-picker">
                    {THEME_OPTIONS.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className={opt.id === theme ? 'active' : ''}
                        onClick={() => onThemeChange(opt.id)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </label>

                <h3>General</h3>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={launchAtLogin}
                    onChange={(e) => void toggle('launchAtLogin', e.target.checked, setLaunchAtLogin)}
                  />
                  <span>Launch Baton at login</span>
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={notify}
                    onChange={(e) => void toggle('notify.enabled', e.target.checked, setNotify)}
                  />
                  <span>Notify when something is blocked on you</span>
                </label>
              </section>
            )}

            {active !== 'general' && active !== 'environment' && (
              <section className="provider">
                <h3>
                  {PROVIDER_LABEL[active] ?? active}
                  {connected.includes(active as ProviderId) && <span className="badge">connected</span>}
                </h3>
                {(fields[active] ?? []).map(field)}
                {active === 'jira' && JIRA_EXTRA_FIELDS.map(field)}
                <button
                  className="primary"
                  disabled={saving === active}
                  onClick={() =>
                    void save(
                      [...(fields[active] ?? []), ...(active === 'jira' ? JIRA_EXTRA_FIELDS : [])],
                      active
                    )
                  }
                >
                  {saving === active ? 'Saving…' : `Save ${PROVIDER_LABEL[active] ?? active}`}
                </button>
              </section>
            )}

            {active === 'environment' && (
              <section className="provider">
                <h3>
                  Dev environment
                  {configured && <span className="badge">configured</span>}
                </h3>
                {ENVIRONMENT_FIELDS.map(field)}
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={basicAuth}
                    onChange={(e) => void toggle('verify.basicAuth', e.target.checked, setBasicAuth)}
                  />
                  <span>Site sits behind a separate HTTP Basic Auth wall</span>
                </label>
                {basicAuth && BASIC_AUTH_FIELDS.map(field)}
                <p className="settings-note">
                  Handed to the agent only as environment variables when it runs "Check it
                  shipped" — never written into the prompt, and never sent anywhere else.
                </p>
                <button
                  className="primary"
                  disabled={saving === 'environment'}
                  onClick={() =>
                    void save([...ENVIRONMENT_FIELDS, ...(basicAuth ? BASIC_AUTH_FIELDS : [])], 'environment')
                  }
                >
                  {saving === 'environment' ? 'Saving…' : 'Save environment'}
                </button>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
