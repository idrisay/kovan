/**
 * Credentials, split out of the extension's `infra/AuthManager.ts`.
 *
 * The original mixed two jobs: deciding what a provider needs in order to be
 * connected, and putting VS Code input boxes on screen to collect it. Only the
 * first belongs in shared code — the desktop app collects the same values from
 * a settings pane, not a quick-pick — so the prompting half stayed behind in
 * each host and this is the half both of them share.
 */

import { EventEmitter, type Disposable, type Host } from '@baton/host';
import type { ProviderId } from '@baton/core';

export interface CredentialField {
  /** Settings key this field is stored under, e.g. `jira.baseUrl`. */
  key: string;
  label: string;
  placeholder?: string;
  /** Secrets go to the Keychain, everything else to settings. */
  secret?: boolean;
}

/** What each provider needs before it can answer a query. */
export const CREDENTIAL_FIELDS: Record<ProviderId, CredentialField[]> = {
  github: [{ key: 'github', label: 'GitHub personal access token', secret: true }],
  jira: [
    { key: 'jira.baseUrl', label: 'Jira site URL', placeholder: 'https://acme.atlassian.net' },
    { key: 'jira.email', label: 'Atlassian account email' },
    { key: 'jira', label: 'Jira API token', secret: true }
  ],
  sentry: [
    { key: 'sentry.organization', label: 'Sentry organization slug', placeholder: 'acme' },
    { key: 'sentry', label: 'Sentry auth token', secret: true }
  ],
  grafana: [
    { key: 'grafana.baseUrl', label: 'Grafana URL', placeholder: 'https://acme.grafana.net' },
    { key: 'grafana', label: 'Grafana service account token', secret: true }
  ],
  figma: [{ key: 'figma', label: 'Figma personal access token', secret: true }]
};

export class Credentials {
  private readonly changed = new EventEmitter<ProviderId>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly host: Host) {}

  token(provider: ProviderId): Promise<string | undefined> {
    return this.host.secrets.get(provider);
  }

  async setToken(provider: ProviderId, value: string): Promise<void> {
    await this.host.secrets.set(provider, value);
    this.changed.fire(provider);
  }

  async clear(provider: ProviderId): Promise<void> {
    await this.host.secrets.delete(provider);
    for (const field of CREDENTIAL_FIELDS[provider]) {
      if (!field.secret) {
        await this.host.config.set(field.key, '');
      }
    }
    this.changed.fire(provider);
  }

  /**
   * Whether a provider is ready to be queried.
   *
   * Uses `has` rather than reading the secret, because reading is what makes
   * the Keychain decide whether this process may *see* the value — the
   * expensive part, and the part that can put an authorisation dialog on
   * screen. Answering "is Jira connected?" should never do that.
   */
  async isConnected(provider: ProviderId): Promise<boolean> {
    for (const field of CREDENTIAL_FIELDS[provider]) {
      if (field.secret) {
        if (!(await this.host.secrets.has(field.key))) {
          return false;
        }
      } else if (!this.host.config.get(field.key, '')) {
        return false;
      }
    }
    return true;
  }

  async connected(): Promise<ProviderId[]> {
    const ids = Object.keys(CREDENTIAL_FIELDS) as ProviderId[];
    const flags = await Promise.all(ids.map((id) => this.isConnected(id)));
    return ids.filter((_, i) => flags[i]);
  }

  dispose(): void {
    this.changed.dispose();
  }
}

export type { Disposable };
