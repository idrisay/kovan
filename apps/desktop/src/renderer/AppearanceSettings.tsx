import { ACCENTS, THEMES, type ThemeId } from '@baton/core';
import { setAppearance, useAppearance, usePaintedTheme } from './appearance';

/**
 * Settings › General › Appearance (item 96): the themes and options picked
 * from the reviewers' proposals. Every control paints at once — there is no
 * Save — because the result is right there to look at.
 */
type Mode = 'system' | 'schedule' | 'fixed';

const MODES: { id: Mode; label: string }[] = [
  { id: 'system', label: 'Match macOS' },
  { id: 'schedule', label: 'On a schedule' },
  { id: 'fixed', label: 'Always one' }
];

function ThemeGrid({ value, onPick, label }: { value: ThemeId; onPick: (id: ThemeId) => void; label: string }) {
  return (
    <div className="theme-grid" role="radiogroup" aria-label={label}>
      {THEMES.map((t) => (
        <button
          key={t.id}
          type="button"
          role="radio"
          aria-checked={t.id === value}
          className={t.id === value ? 'active' : ''}
          title={t.hint}
          onClick={() => onPick(t.id)}
        >
          <span className="theme-preview" style={{ background: t.rail }} aria-hidden>
            <span style={{ background: t.editor, color: t.text }}>
              Aa<i style={{ background: t.accent }} />
            </span>
          </span>
          <span className="theme-name">{t.label}</span>
        </button>
      ))}
    </div>
  );
}

function Segmented<T extends string>({ value, options, onPick, label }: {
  value: T; options: { id: T; label: string }[]; onPick: (id: T) => void; label: string;
}) {
  return (
    <div className="theme-picker" role="radiogroup" aria-label={label}>
      {options.map((opt) => (
        <button
          key={opt.id} type="button" role="radio" aria-checked={opt.id === value}
          className={opt.id === value ? 'active' : ''}
          onClick={() => onPick(opt.id)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function AppearanceSettings() {
  const a = useAppearance();
  const painted = usePaintedTheme();
  const mode: Mode = a.theme === 'system' || a.theme === 'schedule' ? a.theme : 'fixed';
  const contrast = painted === 'contrast';
  const near = ACCENTS.find((x) => x.id === a.accent)?.near;

  return (
    <>
      <label>
        <span>Theme</span>
        <Segmented
          label="Theme mode" value={mode} options={MODES}
          onPick={(next) => setAppearance('theme', next === 'fixed' ? painted : next)}
        />
      </label>
      {mode === 'fixed' ? (
        <ThemeGrid label="Theme" value={painted} onPick={(id) => setAppearance('theme', id)} />
      ) : (
        <>
          <p className="settings-note">
            {mode === 'system'
              ? 'Follows macOS Light and Dark — set macOS to Auto and this follows sunrise and sunset.'
              : 'Switches at these times, but only while Baton isn’t the window in front, or when you come back to it — never while you’re reading.'}
          </p>
          <label>
            <span>{mode === 'system' ? 'When macOS is light' : 'Day'}</span>
            <ThemeGrid label="Day theme" value={a.dayTheme} onPick={(id) => setAppearance('dayTheme', id)} />
          </label>
          <label>
            <span>{mode === 'system' ? 'When macOS is dark' : 'Night'}</span>
            <ThemeGrid label="Night theme" value={a.nightTheme} onPick={(id) => setAppearance('nightTheme', id)} />
          </label>
          {mode === 'schedule' && (
            <div className="schedule-times">
              <label>
                <span>Day starts</span>
                <input type="time" value={a.dayStart} onChange={(e) => e.target.value && setAppearance('dayStart', e.target.value)} />
              </label>
              <label>
                <span>Night starts</span>
                <input type="time" value={a.nightStart} onChange={(e) => e.target.value && setAppearance('nightStart', e.target.value)} />
              </label>
            </div>
          )}
        </>
      )}

      <label>
        <span>Accent</span>
        <div className="accent-picker" role="radiogroup" aria-label="Accent colour">
          {ACCENTS.map((x) => (
            <button
              key={x.id} type="button" role="radio" aria-checked={x.id === a.accent}
              className={`${x.id === a.accent ? 'active' : ''}${x.near ? ' near' : ''}`}
              title={x.near ? `${x.label} — close to the “${x.near}” status colour` : x.label}
              onClick={() => setAppearance('accent', x.id)}
            >
              <i style={{ background: x.swatch }} />{x.label}
            </button>
          ))}
        </div>
      </label>
      <p className="settings-note">
        {a.accent === 'macos'
          ? 'Uses the accent colour from System Settings › Appearance. Most macOS accents are close to a status colour (blue to “awaiting review”, red to “failed”…), so a selected row can look like a status.'
          : near
            ? `Close to the “${near}” status colour, so a selected row can look like that status. Teal and Rose are clear of all five.`
            : 'Used only for selection, the main action and links.'}
      </p>

      <label className="checkbox-row">
        <input type="checkbox" checked={a.colorSafeStatus} onChange={(e) => setAppearance('colorSafeStatus', e.target.checked)} />
        <span>Colour-safe status colours — spread further apart for colour-blind eyes</span>
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox" checked={a.statusShapes || contrast} disabled={contrast}
          onChange={(e) => setAppearance('statusShapes', e.target.checked)}
        />
        <span>Show a shape with every status (✓ ⟳ ! ◷ ⇄){contrast ? ' — always on in High Contrast' : ''}</span>
      </label>

      <label>
        <span>List density</span>
        <Segmented
          label="List density" value={a.density}
          options={[{ id: 'comfortable', label: 'Comfortable' }, { id: 'compact', label: 'Compact' }]}
          onPick={(v) => setAppearance('density', v)}
        />
      </label>
      <label>
        <span>Terminal colours</span>
        <Segmented
          label="Terminal colours" value={a.terminalColors}
          options={[{ id: 'integrated', label: 'From the theme' }, { id: 'boosted', label: 'Boosted' }]}
          onPick={(v) => setAppearance('terminalColors', v)}
        />
      </label>
    </>
  );
}
