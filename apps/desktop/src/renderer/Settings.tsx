import { useEffect, useState } from 'react';
import { ACTIVITY_SETTINGS, ActivitySettings } from './Activity';
import { DictationSettings } from './Dictation';
import {
  DEFAULT_IDLE_MINUTES, DEFAULT_PRICES, NV_REVIEW_DEFAULT_MODEL, PRICE_CHECK_RUNNERS, QUICK_DEFAULT_MODEL,
  QUICK_DEFAULT_TIMEOUT_SECONDS, applyPriceProposals,
  type Price, type PriceCheckRunner, type PriceProposal, type PriceRule, type ProviderId
} from '@kovan/core';
import { savePrices, useUsage } from './Usage';
import { AppearanceSettings } from './AppearanceSettings';
import { FontSizeControl, useTerminalFontSize } from './terminalFontSize';
import { TestEnvironmentSettings } from './TestEnvironments';
import { ChromeSizeControl, ReadingSizeControl, SidebarSizeControl, useChromeSize, useReadingSize, useSidebarSize } from './readingSize';
import { useAppearance } from './appearance';
import { ACCENTS, THEMES, speechProvider } from '@kovan/core';
import { ChevronIcon, CloseIcon, SearchIcon } from './icons';

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
 * modal sheet, not a window, and the fields below are exactly what Kovan's
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
    void window.kovan.settings().then((settings) => {
      setModel(typeof settings['quick.model'] === 'string' ? settings['quick.model'] : '');
      const seconds = settings['quick.timeoutSeconds'];
      if (typeof seconds === 'number') setTimeoutSeconds(String(seconds));
      setNvModel(typeof settings['review.nvModel'] === 'string' ? settings['review.nvModel'] : '');
    });
  }, []);

  async function runTest() {
    setTest({ running: true });
    const result = await window.kovan.quickTest(model.trim() || undefined);
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
        Used only by Summarize on a pull request and Condense on a ticket. It reads text Kovan already has and
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
          onBlur={() => void window.kovan.setSetting('quick.model', model.trim())}
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
            void window.kovan.setSetting('quick.timeoutSeconds', seconds);
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
          onBlur={() => void window.kovan.setSetting('review.nvModel', nvModel.trim())}
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

/** When Running agents calls an agent idle, and whether Kovan says so. */
function RunningAgentSettings() {
  const [minutes, setMinutes] = useState(String(DEFAULT_IDLE_MINUTES));
  const [remind, setRemind] = useState(true);
  useEffect(() => {
    void window.kovan.settings().then((settings) => {
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
            void window.kovan.setSetting('agents.idleMinutes', value);
          }}
        />
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={remind}
          onChange={(e) => {
            setRemind(e.target.checked);
            void window.kovan.setSetting('agents.remind', e.target.checked);
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

const PRICE_CHECK_KEY = 'kovan.price-check';

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
    const result = await window.kovan.priceCheck(runner, model, rules);
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
            <button type="button" className="link" onClick={() => void window.kovan.priceCheckCancel()}>Cancel</button>
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
                          <button type="button" className="link" onClick={() => void window.kovan.openExternal(p.source!)}>
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

type SectionId = 'appearance' | 'text' | 'notifications' | 'dictation' | 'agents' | 'connections' | 'environments';

/**
 * Settings as one list (item 99, option B): each section is a single row that
 * shows its current values, and opens in place — one at a time — so the
 * window never becomes one long scroll of everything. A section's body only
 * mounts when it opens, so nothing a section loads (models, prices, speech
 * setup) runs just because Settings was opened.
 */
const SECTIONS: { id: SectionId; title: string; icon: string; ownHeading?: boolean }[] = [
  { id: 'appearance', title: 'Appearance', icon: '◐' },
  { id: 'text', title: 'Text & terminal', icon: 'Aa' },
  { id: 'notifications', title: 'Notifications', icon: '◔' },
  // These two bodies open with their own heading, which the row already says.
  { id: 'dictation', title: 'Dictation', icon: '◉', ownHeading: true },
  { id: 'agents', title: 'Agents', icon: '▸' },
  { id: 'connections', title: 'Connections', icon: '⎇' },
  { id: 'environments', title: 'Environments', icon: '⌂', ownHeading: true }
];

/** The names search looks through — each setting's label as it appears in
 *  the section, plus words people use for it. */
const SEARCH_INDEX: Record<SectionId, string[]> = {
  appearance: ['Theme', 'Dark', 'Light', 'OLED Black', 'Cool Graphite', 'Ember Low Light', 'High Contrast', 'Paper Soft',
    'Match macOS', 'Schedule', 'Accent', 'Colour-safe status colours', 'Show a shape with every status', 'List density',
    'Compact', 'Terminal colours', 'Boosted', 'Color', 'Night'],
  text: ['Terminal font size', 'Ticket and pull request text size', 'Sidebar text size',
    'Tabs, session header and status bar text size', 'Status bar', 'Tabs', 'Font', 'Zoom'],
  notifications: ['macOS notifications', 'Launch Kovan at login', 'Activity', ...ACTIVITY_SETTINGS.map((a) => a.label)],
  dictation: ['Dictate with double-tap ⌘', 'Speech model', 'Apple Speech', 'whisper.cpp', 'OpenAI Whisper', 'Groq Whisper',
    'Deepgram', 'AssemblyAI', 'API key', 'Model file', 'Language', 'Microphone', 'Voice'],
  agents: ['Quick model', 'Model (opencode)', 'Give up after (seconds)', 'Running agents', 'Idle after (minutes)',
    'Remind me when an agent goes idle', 'Token prices', 'Usage', 'Cost', 'Review model'],
  connections: ['Token', 'API key'],
  environments: ['Environments', 'Test accounts', 'Site URL', 'Basic auth', 'Check it shipped', 'Password']
};

export function Settings({
  onClose,
  connected
}: {
  onClose: () => void;
  connected: ProviderId[];
}) {
  const [fields, setFields] = useState<Record<string, Field[]>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [launchAtLogin, setLaunchAtLogin] = useState(false);
  const [notify, setNotify] = useState(true);
  const [saving, setSaving] = useState('');
  /** Which section is open; one at a time, none at first. */
  const [open, setOpen] = useState<SectionId>();
  const [query, setQuery] = useState('');
  /** Every setting as saved, for the one-line summaries. Re-read when a
   *  section closes, so a summary shows what was just changed. */
  const [raw, setRaw] = useState<Record<string, unknown>>({});
  const appearance = useAppearance();
  const [reading] = useReadingSize();
  const [sidebar] = useSidebarSize();
  const [chrome] = useChromeSize();
  const [saveResult, setSaveResult] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [fontSize, bumpFontSize] = useTerminalFontSize();

  useEffect(() => {
    void window.kovan.credentialFields().then(setFields);
    void window.kovan.settings().then((settings) => {
      const seed: Record<string, string> = {};
      for (const [key, value] of Object.entries(settings)) {
        if (typeof value === 'string') {
          seed[key] = value;
        }
      }
      setValues(seed);
      setRaw(settings);
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
          ? window.kovan.setSecret(field.key, value)
          : window.kovan.setSetting(field.key, value));
      }
      // A save that only touched non-secret fields (e.g. fixing a typo'd
      // project slug) never went through `setSecret`, which is the only
      // path that already re-polls — so ask for a fresh read here too.
      // Without it, a provider that just became fully configured would sit
      // showing "not connected" until the next scheduled poll, which is
      // exactly what looked like "does not return anything".
      if (section !== 'general' && section !== 'environment') {
        await window.kovan.refresh();
        const missing = await window.kovan.missingFields(section as ProviderId);
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
    await window.kovan.setSetting(key, value);
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

  const providers = Object.keys(fields);
  const label = (id: string) => PROVIDER_LABEL[id] ?? id;
  const themeName = (id: string) => THEMES.find((t) => t.id === id)?.label ?? id;
  const on = (key: string) => raw[key] !== false;

  // What each row says about itself when closed — Kovan's state in seven lines.
  const summary: Record<SectionId, string> = {
    appearance: [
      appearance.theme === 'system' ? `Match macOS · ${themeName(appearance.dayTheme)} / ${themeName(appearance.nightTheme)}`
        : appearance.theme === 'schedule' ? `Schedule ${appearance.dayStart}–${appearance.nightStart} · ${themeName(appearance.dayTheme)} / ${themeName(appearance.nightTheme)}`
          : themeName(appearance.theme),
      ACCENTS.find((x) => x.id === appearance.accent)?.label ?? appearance.accent,
      appearance.statusShapes ? 'shapes on' : 'shapes off',
      appearance.density === 'compact' ? 'compact' : ''
    ].filter(Boolean).join(' · '),
    text: `Terminal ${fontSize} · Reading ${reading}% · Sidebar ${sidebar}% · Tabs and status bar ${chrome}%`,
    notifications: [
      notify ? 'macOS notifications on' : 'macOS notifications off',
      `${ACTIVITY_SETTINGS.filter((a) => on(a.setting)).length} of ${ACTIVITY_SETTINGS.length} activity kinds`,
      launchAtLogin ? 'launch at login' : ''
    ].filter(Boolean).join(' · '),
    dictation: on('dictation.enabled')
      ? [
          'Double-tap ⌘',
          speechProvider(raw['dictation.provider']).label,
          typeof raw['dictation.locale'] === 'string' && raw['dictation.locale'] ? raw['dictation.locale'] : 'automatic language'
        ].join(' · ')
      : 'Off',
    agents: [
      `Quick model ${typeof raw['quick.model'] === 'string' && raw['quick.model'] ? raw['quick.model'] : 'default'}`,
      `idle after ${Number(raw['agents.idleMinutes']) || DEFAULT_IDLE_MINUTES} min`,
      on('agents.remind') ? 'reminders on' : 'reminders off'
    ].join(' · '),
    connections: providers.length === 0 ? '' : [
      ...providers.filter((id) => connected.includes(id as ProviderId)).map((id) => `✓ ${label(id)}`),
      (() => {
        const off = providers.filter((id) => !connected.includes(id as ProviderId)).map(label);
        return off.length ? `${off.join(', ')} not connected` : '';
      })()
    ].filter(Boolean).join(' · '),
    environments: (() => {
      const envs = Array.isArray(raw['verify.environments']) ? raw['verify.environments'] as { name?: string }[] : [];
      const accounts = Array.isArray(raw['verify.accounts']) ? raw['verify.accounts'].length : 0;
      return envs.length === 0 ? 'None yet' : `${envs.map((e) => e.name || 'Unnamed').join(', ')} · ${accounts} test account${accounts === 1 ? '' : 's'}`;
    })()
  };

  // Search: every setting's name, and a few words people use for it, so
  // "key", "font" or "idle" finds its row and says which setting matched.
  const index: Record<SectionId, string[]> = {
    ...SEARCH_INDEX,
    connections: [
      ...SEARCH_INDEX.connections,
      ...providers.flatMap((id) => [label(id), ...(fields[id] ?? []).map((f) => f.label), ...(EXTRA_FIELDS[id] ?? []).map((f) => f.label)])
    ]
  };
  const q = query.trim().toLowerCase();
  const matches = (id: SectionId) => (q ? index[id].filter((term) => term.toLowerCase().includes(q)) : []);
  const visible = SECTIONS.filter((s) => !q || s.title.toLowerCase().includes(q) || matches(s.id).length > 0);

  const toggleOpen = (id: SectionId, find?: string) => {
    const next = open === id && !find ? undefined : id;
    setOpen(next);
    // Summaries follow what was just changed in the section being left.
    void window.kovan.settings().then(setRaw);
    if (next && find) {
      // Once the section has rendered, bring the setting that matched into view.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const body = document.getElementById(`settings-${next}`);
        const hit = Array.from(body?.querySelectorAll('label, h3, p, button, td, th') ?? [])
          .find((el) => el.textContent?.toLowerCase().includes(find.toLowerCase()));
        if (hit instanceof HTMLElement) {
          hit.scrollIntoView({ block: 'center' });
          hit.classList.add('settings-found');
          setTimeout(() => hit.classList.remove('settings-found'), 1_600);
        }
      }));
    }
  };

  const sectionBody = (id: SectionId) => {
    switch (id) {
      case 'appearance':
        return <AppearanceSettings />;
      case 'text':
        return (
          <>
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
            <label>
              <span>Tabs, session header and status bar text size</span>
              <ChromeSizeControl />
            </label>
            <p className="settings-note">⌘+ and ⌘− resize whichever of these you last clicked in: the sidebar, the ticket or pull request, a terminal, or its tabs, header and the status bar. Terminal colours are under Appearance.</p>
          </>
        );
      case 'notifications':
        return (
          <>
            <label className="checkbox-row">
              <input type="checkbox" checked={notify} onChange={(e) => void toggle('notify.enabled', e.target.checked, setNotify)} />
              <span>macOS notifications: blocked pull requests, and Activity while Kovan isn't in front</span>
            </label>
            <label className="checkbox-row">
              <input type="checkbox" checked={launchAtLogin} onChange={(e) => void toggle('launchAtLogin', e.target.checked, setLaunchAtLogin)} />
              <span>Launch Kovan at login</span>
            </label>
            <ActivitySettings />
          </>
        );
      case 'dictation':
        return <DictationSettings />;
      case 'agents':
        return (
          <>
            <QuickModelSettings />
            <RunningAgentSettings />
            <TokenPriceSettings />
          </>
        );
      case 'connections':
        return providers.map((provider) => (
          <div key={provider} className="settings-connection">
            <h3>
              {label(provider)}
              {connected.includes(provider as ProviderId) && <span className="badge">connected</span>}
            </h3>
            {(fields[provider] ?? []).map(field)}
            {(EXTRA_FIELDS[provider] ?? []).map(field)}
            <button
              className="primary"
              disabled={saving === provider}
              onClick={() => void save([...(fields[provider] ?? []), ...(EXTRA_FIELDS[provider] ?? [])], provider)}
            >
              {saving === provider ? 'Saving…' : `Save ${label(provider)}`}
            </button>
            {saveResult[provider] && (
              <p className={saveResult[provider].ok ? 'settings-note ok' : 'settings-note error'}>{saveResult[provider].text}</p>
            )}
          </div>
        ));
      case 'environments':
        return <TestEnvironmentSettings />;
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet settings" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2>Settings</h2>
          <button type="button" className="icon-button boxed" aria-label="Close" title="Close" onClick={onClose}>
            <CloseIcon size={14} />
          </button>
        </header>

        <div className="settings-list">
          <div className="settings-search">
            <SearchIcon size={13} />
            <input
              id="settings-search" type="text" value={query} autoFocus spellCheck={false}
              placeholder="Search settings — try “key”, “font” or “idle”"
              aria-label="Search settings"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && visible[0]) toggleOpen(visible[0].id, matches(visible[0].id)[0]);
                if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); }
              }}
            />
          </div>

          {visible.length === 0 && <p className="settings-none">No setting matches “{query.trim()}”.</p>}
          {visible.map((section) => {
            const isOpen = open === section.id;
            const found = matches(section.id);
            return (
              <section key={section.id} className={isOpen ? 'settings-row open' : 'settings-row'} data-section={section.id}>
                <button
                  type="button" className="settings-row-head" aria-expanded={isOpen} aria-controls={`settings-${section.id}`}
                  onClick={() => toggleOpen(section.id)}
                >
                  <span className="settings-row-icon" aria-hidden="true">{section.icon}</span>
                  <span className="settings-row-title">{section.title}</span>
                  <span className="settings-row-summary">
                    {summary[section.id]}
                  </span>
                  <span className="settings-row-chevron" aria-hidden="true"><ChevronIcon size={12} open={isOpen} /></span>
                </button>
                {!isOpen && found.length > 0 && (
                  <div className="settings-hits">
                    {found.slice(0, 6).map((term) => (
                      <button key={term} type="button" className="settings-hit" onClick={() => toggleOpen(section.id, term)}>{term}</button>
                    ))}
                  </div>
                )}
                {isOpen && (
                  <div className={`settings-row-body provider ${section.ownHeading ? 'own-heading' : ''}`} id={`settings-${section.id}`}>
                    {sectionBody(section.id)}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
