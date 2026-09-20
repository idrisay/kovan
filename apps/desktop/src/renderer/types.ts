import type { JiraIssue, ProviderId, PullSummary } from '@baton/core';

export interface Snapshot {
  at: number;
  viewer: string;
  blocked: PullSummary[];
  mine: PullSummary[];
  reviewRequested: PullSummary[];
  tickets: JiraIssue[];
  connected: ProviderId[];
  errors: { provider: ProviderId; message: string }[];
  refreshing: boolean;
}

export interface BatonApi {
  snapshot(): Promise<Snapshot>;
  refresh(): Promise<Snapshot>;
  openExternal(url: string): Promise<void>;
  credentialFields(): Promise<Record<string, { key: string; label: string; placeholder?: string; secret?: boolean }[]>>;
  settings(): Promise<Record<string, unknown>>;
  setSetting(key: string, value: unknown): Promise<void>;
  setSecret(key: string, value: string): Promise<Snapshot>;
  onSnapshot(listener: (snapshot: Snapshot) => void): () => void;
}

declare global {
  interface Window {
    baton: BatonApi;
  }
}
