import { useEffect, useState } from 'react';
import type { ProviderId } from '@baton/core';
import type { ThemeChoice } from './types';
import { FontSizeControl, useTerminalFontSize } from './terminalFontSize';

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
 * Same reasoning as `JIRA_EXTRA_FIELDS`: not a `CREDENTIAL_FIELDS` entry, so
 * leaving it blank does not read as "not connected" — here that mattered
 * enough to be its own bug report. Blank is not a placeholder state on its
 * way to being filled in; it is the normal way to ask for every project.
 */
const SENTRY_EXTRA_FIELDS: Field[] = [
  {
    key: 'sentry.project',
    label: 'Only show one project (optional)',
    placeholder: 'Leave blank to see every project'
  }
];

/** Extra, non-gating fields per provider — see the two arrays above. */
const EXTRA_FIELDS: Partial<Record<string, Field[]>> = {
  jira: JIRA_EXTRA_FIELDS,
  sentry: SENTRY_EXTRA_FIELDS
};

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
  const [saveResult, setSaveResult] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [fontSize, bumpFontSize] = useTerminalFontSize();

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
    setSaveResult((r) => ({ ...r, [section]: undefined as unknown as { ok: boolean; text: string } }));
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
      // A save that only touched non-secret fields (e.g. fixing a typo'd
      // project slug) never went through `setSecret`, which is the only
      // path that already re-polls — so ask for a fresh read here too.
      // Without it, a provider that just became fully configured would sit
      // showing "not connected" until the next scheduled poll, which is
      // exactly what looked like "does not return anything".
      if (section !== 'general' && section !== 'environment') {
        await window.baton.refresh();
        const missing = await window.baton.missingFields(section as ProviderId);
        setSaveResult((r) => ({
          ...r,
          [section]: missing.length === 0
            ? { ok: true, text: 'Saved — connected.' }
            : { ok: false, text: `Saved, but still missing: ${missing.join(', ')}.` }
        }));
      } else {
        setSaveResult((r) => ({ ...r, [section]: { ok: true, text: 'Saved.' } }));
      }
    } catch (err) {
      setSaveResult((r) => ({
        ...r,
        [section]: { ok: false, text: err instanceof Error ? err.message : 'Save failed.' }
      }));
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
                <label>
                  <span>Terminal font size</span>
                  <FontSizeControl size={fontSize} onBump={bumpFontSize} />
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
                {(EXTRA_FIELDS[active] ?? []).map(field)}
                <button
                  className="primary"
                  disabled={saving === active}
                  onClick={() =>
                    void save([...(fields[active] ?? []), ...(EXTRA_FIELDS[active] ?? [])], active)
                  }
                >
                  {saving === active ? 'Saving…' : `Save ${PROVIDER_LABEL[active] ?? active}`}
                </button>
                {saveResult[active] && (
                  <p className={saveResult[active].ok ? 'settings-note ok' : 'settings-note error'}>
                    {saveResult[active].text}
                  </p>
                )}
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
                {saveResult['environment'] && (
                  <p className={saveResult['environment'].ok ? 'settings-note ok' : 'settings-note error'}>
                    {saveResult['environment'].text}
                  </p>
                )}
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
