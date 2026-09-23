import { useEffect, useState } from 'react';
import {
  DEFAULT_IDLE_MINUTES, DEFAULT_PRICES, NV_REVIEW_DEFAULT_MODEL, PRICE_CHECK_RUNNERS, QUICK_DEFAULT_MODEL,
  QUICK_DEFAULT_TIMEOUT_SECONDS, applyPriceProposals,
  type Price, type PriceCheckRunner, type PriceProposal, type PriceRule, type ProviderId
} from '@baton/core';
import { savePrices, useUsage } from './Usage';
import type { ThemeChoice } from './types';
import { FontSizeControl, useTerminalFontSize } from './terminalFontSize';
import { TestEnvironmentSettings } from './TestEnvironments';
import { ReadingSizeControl, SidebarSizeControl } from './readingSize';
import { CloseIcon } from './icons';

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
/**
 * The model behind "Summarize" and "Condense". Saved on blur, like a native
 * preferences pane, since there is no provider to re-check on Save.
 */
function QuickModelSettings() {
  const [model, setModel] = useState('');
  const [timeout, setTimeoutSeconds] = useState(String(QUICK_DEFAULT_TIMEOUT_SECONDS));
  const [nvModel, setNvModel] = useState('');
  const [test, setTest] = useState<{ running?: boolean; ok?: boolean; text?: string }>({});

  useEffect(() => {
    void window.baton.settings().then((settings) => {
      setModel(typeof settings['quick.model'] === 'string' ? settings['quick.model'] : '');
      const seconds = settings['quick.timeoutSeconds'];
      if (typeof seconds === 'number') setTimeoutSeconds(String(seconds));
      setNvModel(typeof settings['review.nvModel'] === 'string' ? settings['review.nvModel'] : '');
    });
  }, []);

  async function runTest() {
    setTest({ running: true });
    const result = await window.baton.quickTest(model.trim() || undefined);
    setTest(
      result.ok
        ? { ok: true, text: `Answered in ${(result.ms / 1000).toFixed(1)}s` }
        : { ok: false, text: result.error ?? 'No answer.' }
    );
  }

  return (
    <>
      <h3>Quick model</h3>
      <p className="settings-note">
        Used only by Summarize on a pull request and Condense on a ticket. It reads text Baton already has and
        returns text, with every tool call refused. Agent runs never use it.
      </p>
      <p className="settings-note">
        "Review with nv-review" on a pull request is separate: it sends the diff through your
        <code> nv-review </code> shell function (NVIDIA's free API, key in ~/.config/nvidia/key), gives up after
        20 minutes, and saves the review as kimi-k3-review.md in the PR's History. The review recommends approve or
        request changes; nothing reaches GitHub until you pick one and confirm.
      </p>
      <label>
        <span>Model (opencode)</span>
        <input
          type="text"
          placeholder={QUICK_DEFAULT_MODEL}
          value={model}
          onChange={(e) => setModel(e.target.value)}
          onBlur={() => void window.baton.setSetting('quick.model', model.trim())}
        />
      </label>
      <label>
        <span>Give up after (seconds)</span>
        <input
          type="number"
          min={10}
          value={timeout}
          onChange={(e) => setTimeoutSeconds(e.target.value)}
          onBlur={() => {
            const seconds = Math.max(10, Math.round(Number(timeout) || QUICK_DEFAULT_TIMEOUT_SECONDS));
            setTimeoutSeconds(String(seconds));
            void window.baton.setSetting('quick.timeoutSeconds', seconds);
          }}
        />
      </label>
      <label>
        <span>nv-review model (NVIDIA)</span>
        <input
          type="text"
          placeholder={NV_REVIEW_DEFAULT_MODEL}
          value={nvModel}
          onChange={(e) => setNvModel(e.target.value)}
          onBlur={() => void window.baton.setSetting('review.nvModel', nvModel.trim())}
        />
      </label>
      <p className="settings-note">
        Passed to nv-review as <code>NV_MODEL</code>. Try <code>nvidia/nemotron-3-super-120b-a12b</code> while Kimi K3 is
        overloaded.
      </p>
      <div className="quick-test-row">
        <button type="button" className="ghost" disabled={test.running} onClick={() => void runTest()}>
          {test.running ? 'Testing…' : 'Test'}
        </button>
        {test.text && <span className={test.ok ? 'settings-note ok' : 'settings-note error'}>{test.text}</span>}
      </div>
    </>
  );
}

/** When Running agents calls an agent idle, and whether Baton says so. */
function RunningAgentSettings() {
  const [minutes, setMinutes] = useState(String(DEFAULT_IDLE_MINUTES));
  const [remind, setRemind] = useState(true);
  useEffect(() => {
    void window.baton.settings().then((settings) => {
      const stored = Number(settings['agents.idleMinutes']);
      if (stored > 0) setMinutes(String(stored));
      setRemind(settings['agents.remind'] !== false);
    });
  }, []);
  return (
    <>
      <h3>Running agents</h3>
      <label>
        <span>Idle after (minutes)</span>
        <input
          type="number" min={5} max={1440} step={5}
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
          onBlur={() => {
            const value = Math.min(1440, Math.max(5, Math.round(Number(minutes)) || DEFAULT_IDLE_MINUTES));
            setMinutes(String(value));
            void window.baton.setSetting('agents.idleMinutes', value);
          }}
        />
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={remind}
          onChange={(e) => {
            setRemind(e.target.checked);
            void window.baton.setSetting('agents.remind', e.target.checked);
          }}
        />
        <span>Remind me when an agent goes idle</span>
      </label>
      <p className="settings-note">
        One notification per agent, when it has done nothing for that long. It never stops anything; Sessions → Running
        agents does, after asking.
      </p>
    </>
  );
}

/**
 * USD per million tokens, per model family: what Token usage multiplies by.
 * The first rule whose text appears in the model name wins, so a specific
 * rule goes above a general one.
 */
function TokenPriceSettings() {
  const { prices } = useUsage();
  const [rows, setRows] = useState<PriceRule[]>(prices);
  useEffect(() => setRows(prices), [prices]);
  const custom = prices !== DEFAULT_PRICES;
  const fields: { key: keyof Price; label: string }[] = [
    { key: 'input', label: 'Input' }, { key: 'output', label: 'Output' }, { key: 'cacheWrite', label: 'Cache write' },
    { key: 'cacheWrite1h', label: 'Cache write 1h' }, { key: 'cacheRead', label: 'Cache read' }
  ];
  const commit = (next: PriceRule[]) => savePrices(next.filter((r) => r.match.trim()));

  return (
    <>
      <h3>Token prices</h3>
      <p className="settings-note">
        USD per million tokens, used for the API-equivalent cost in Token usage. A subscription is not billed this way;
        these only put a comparable price on what each session used. The first row whose text appears in a model's name
        prices it, so put specific rows above general ones. A model no row matches shows as "no price".
      </p>
      <div className="price-table-wrap">
        <table className="price-table">
          <thead>
            <tr><th>Model name contains</th>{fields.map((f) => <th key={f.key}>{f.label}</th>)}<th /></tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                <td>
                  <input
                    id={`price-match-${i}`}
                    type="text" value={row.match} aria-label="Model name contains"
                    onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, match: e.target.value } : r)))}
                    onBlur={() => commit(rows)}
                  />
                </td>
                {fields.map((f) => (
                  <td key={f.key}>
                    <input
                      id={`price-${f.key}-${i}`}
                      type="number" min={0} step="0.01" value={row[f.key]} aria-label={f.label}
                      onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, [f.key]: Math.max(0, Number(e.target.value) || 0) } : r)))}
                      onBlur={() => commit(rows)}
                    />
                  </td>
                ))}
                <td>
                  <button type="button" className="link" onClick={() => commit(rows.filter((_, j) => j !== i))}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="quick-test-row">
        <button
          type="button" className="ghost"
          onClick={() => setRows([...rows, { match: '', input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 }])}
        >
          Add a row
        </button>
        {custom && <button type="button" className="link" onClick={() => savePrices(undefined)}>Reset to list prices</button>}
      </div>
      <PriceCheckPanel rules={prices} fields={fields} />
    </>
  );
}

const PRICE_CHECK_KEY = 'baton.price-check';

function hostOf(url: string): string {
  try { return new URL(url).hostname || url; } catch { return url; }
}

function rememberedCheck(): { runner: PriceCheckRunner; model: string } {
  try {
    const saved = JSON.parse(localStorage.getItem(PRICE_CHECK_KEY) ?? '{}') as { runner?: string; model?: string };
    const runner = PRICE_CHECK_RUNNERS.find((r) => r.id === saved.runner)?.id ?? 'claude';
    return { runner, model: typeof saved.model === 'string' ? saved.model : 'sonnet' };
  } catch {
    return { runner: 'claude', model: 'sonnet' };
  }
}

/**
 * "Check prices online": pick who looks (Claude Code, Codex or opencode, and
 * which model), and it searches the providers' pricing pages for every row in
 * the table. What comes back is shown beside today's numbers with a tick per
 * row — changed rows ticked, new ones not — and only "Apply" touches the table.
 */
function PriceCheckPanel({ rules, fields }: { rules: PriceRule[]; fields: { key: keyof Price; label: string }[] }) {
  const [open, setOpen] = useState(false);
  const [{ runner, model }, setChoice] = useState(rememberedCheck);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const [proposals, setProposals] = useState<PriceProposal[]>();
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const choose = (next: { runner: PriceCheckRunner; model: string }) => {
    setChoice(next);
    try { localStorage.setItem(PRICE_CHECK_KEY, JSON.stringify(next)); } catch { /* a preference */ }
  };

  const currentFor = (match: string) => rules.find((r) => r.match.toLowerCase() === match.toLowerCase());
  const changed = (p: PriceProposal) => {
    const now = currentFor(p.match);
    return !now || fields.some((f) => now[f.key] !== p[f.key]);
  };

  async function check() {
    setRunning(true);
    setError(undefined);
    setProposals(undefined);
    const result = await window.baton.priceCheck(runner, model, rules);
    setRunning(false);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    setProposals(result.proposals);
    setPicked(new Set(result.proposals.filter((p) => !p.added && changed(p)).map((p) => p.match)));
  }

  function apply() {
    if (!proposals) return;
    savePrices(applyPriceProposals(rules, proposals.filter((p) => picked.has(p.match))));
    setProposals(undefined);
  }

  if (!open) {
    return (
      <div className="quick-test-row">
        <button type="button" className="ghost" onClick={() => setOpen(true)}>Check prices online…</button>
      </div>
    );
  }

  const defaultModel = PRICE_CHECK_RUNNERS.find((r) => r.id === runner)?.defaultModel;
  return (
    <div className="price-check">
      <div className="price-check-form">
        <label>
          <span>Search with</span>
          <select
            value={runner} disabled={running}
            onChange={(e) => {
              const next = e.target.value as PriceCheckRunner;
              choose({ runner: next, model: PRICE_CHECK_RUNNERS.find((r) => r.id === next)?.defaultModel ?? '' });
            }}
          >
            {PRICE_CHECK_RUNNERS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
        </label>
        <label>
          <span>Model</span>
          <input
            type="text" value={model} disabled={running}
            placeholder={defaultModel || 'its default'}
            onChange={(e) => choose({ runner, model: e.target.value })}
          />
        </label>
        {running ? (
          <>
            <span className="settings-note price-check-status">Searching pricing pages… this can take a minute or two.</span>
            <button type="button" className="link" onClick={() => void window.baton.priceCheckCancel()}>Cancel</button>
          </>
        ) : (
          <>
            <button type="button" className="ghost" onClick={() => void check()}>Check</button>
            <button type="button" className="link" onClick={() => { setOpen(false); setProposals(undefined); setError(undefined); }}>Close</button>
          </>
        )}
      </div>
      <p className="settings-note">
        Runs headless with only web search and web fetch allowed, and spends that model's tokens. Nothing changes
        until you apply what it found.
      </p>
      {error && <p className="error boxed">{error}</p>}
      {proposals && (
        <>
          <div className="price-table-wrap">
            <table className="price-table price-check-table">
              <thead>
                <tr><th /><th>Model name contains</th>{fields.map((f) => <th key={f.key}>{f.label}</th>)}<th>Source</th></tr>
              </thead>
              <tbody>
                {proposals.map((p) => {
                  const now = currentFor(p.match);
                  return (
                    <tr key={p.match} className={changed(p) ? '' : 'same'}>
                      <td className="checkbox-row">
                        <input
                          type="checkbox" aria-label={`Apply ${p.match}`}
                          checked={picked.has(p.match)}
                          onChange={(e) => {
                            const next = new Set(picked);
                            if (e.target.checked) next.add(p.match); else next.delete(p.match);
                            setPicked(next);
                          }}
                        />
                      </td>
                      <td>{p.match}{p.added && <span className="price-check-new">new</span>}</td>
                      {fields.map((f) => (
                        <td key={f.key}>
                          {now && now[f.key] !== p[f.key] ? (
                            <><s>{now[f.key]}</s> <strong>{p[f.key]}</strong></>
                          ) : (
                            p[f.key]
                          )}
                        </td>
                      ))}
                      <td>
                        {p.source && (
                          <button type="button" className="link" onClick={() => void window.baton.openExternal(p.source!)}>
                            {hostOf(p.source)}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="quick-test-row">
            <button type="button" className="ghost" disabled={picked.size === 0} onClick={apply}>
              Apply {picked.size} {picked.size === 1 ? 'row' : 'rows'}
            </button>
            <button type="button" className="link" onClick={() => setProposals(undefined)}>Discard</button>
            {proposals.every((p) => !changed(p)) && <span className="settings-note">Every price already matches.</span>}
          </div>
        </>
      )}
    </div>
  );
}

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

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet settings" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2>Settings</h2>
          <button type="button" className="icon-button boxed" aria-label="Close" title="Close" onClick={onClose}>
            <CloseIcon size={14} />
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
                {id === 'general' ? 'General' : id === 'environment' ? 'Environments' : PROVIDER_LABEL[id] ?? id}
                {id !== 'general' && id !== 'environment' && connected.includes(id as ProviderId) && (
                  <span className="badge">connected</span>
                )}
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
                <label>
                  <span>Ticket and pull request text size</span>
                  <ReadingSizeControl />
                </label>
                <label>
                  <span>Sidebar text size</span>
                  <SidebarSizeControl />
                </label>
                <p className="settings-note">⌘+ and ⌘− resize whichever of the three you last clicked in: the sidebar, the ticket or pull request, or a terminal.</p>

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

                <QuickModelSettings />
                <RunningAgentSettings />
                <TokenPriceSettings />
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

            {active === 'environment' && <TestEnvironmentSettings />}
          </div>
        </div>
      </div>
    </div>
  );
}
