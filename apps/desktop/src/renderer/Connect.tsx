import { useEffect, useState } from 'react';
import type { ProviderId } from '@baton/core';

interface Field {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
}

/**
 * The desktop replacement for the extension's chain of quick-picks and input
 * boxes. It drives off `CREDENTIAL_FIELDS` in `@baton/providers`, so a provider
 * that gains a field gains it in both apps.
 */
export function Connect({
  onClose,
  connected
}: {
  onClose: () => void;
  connected: ProviderId[];
}) {
  const [fields, setFields] = useState<Record<string, Field[]>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

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
    });
  }, []);

  async function save(provider: string) {
    setSaving(true);
    try {
      for (const field of fields[provider] ?? []) {
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
      setSaving(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2>Connections</h2>
          <button className="ghost" onClick={onClose}>
            Done
          </button>
        </header>

        {Object.entries(fields).map(([provider, list]) => (
          <section key={provider} className="provider">
            <h3>
              {provider}
              {connected.includes(provider as ProviderId) && <span className="badge">connected</span>}
            </h3>
            {list.map((field) => (
              <label key={field.key}>
                <span>{field.label}</span>
                <input
                  type={field.secret ? 'password' : 'text'}
                  placeholder={field.placeholder ?? ''}
                  value={values[field.key] ?? ''}
                  onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
                />
              </label>
            ))}
            <button className="primary" disabled={saving} onClick={() => void save(provider)}>
              {saving ? 'Saving…' : `Save ${provider}`}
            </button>
          </section>
        ))}
      </div>
    </div>
  );
}
