/**
 * One settings schema, read by both hosts.
 *
 * The extension declared these in `package.json` under
 * `contributes.configuration`; the desktop app has no such manifest. Declaring
 * them here instead is what stops the two drifting — the VS Code host maps
 * these keys onto its own configuration, and the Electron host onto a JSON
 * file, but neither owns the list.
 *
 * Keys keep their `devhub.`-era spelling minus the prefix, so an existing
 * `defaults read com.idrisay.devhub` import lands on the right names.
 */

import type { AccentId, Density, TerminalColors, ThemeChoice, ThemeId } from './appearance';
import type { TestAccount, TestEnvironment } from './testAccounts';

import type { PathMapping } from './types';

export interface Settings {
  ticketKeyPattern: string;
  branchTemplate: string;

  /** 'system' and 'schedule' switch between the day and night themes below;
   *  a theme id holds regardless of the OS or the time. See `appearance.ts`. */
  'appearance.theme': ThemeChoice;
  'appearance.dayTheme': ThemeId;
  'appearance.nightTheme': ThemeId;
  /** "HH:MM" local, for 'schedule'. */
  'appearance.dayStart': string;
  'appearance.nightStart': string;
  'appearance.accent': AccentId;
  /** Status hues pushed further apart for colour-blind eyes. */
  'appearance.colorSafeStatus': boolean;
  /** A shape beside every status colour (✓ ⟳ ! ◷ ⇄). */
  'appearance.statusShapes': boolean;
  'appearance.density': Density;
  'appearance.terminalColors': TerminalColors;

  'jira.baseUrl': string;
  'jira.email': string;
  'jira.jql': string;
  'jira.tasksJql': string;
  'jira.inProgressTransition': string;
  'jira.tasksLimit': number;

  'github.enabled': boolean;
  'github.baseUrl': string;
  'github.limit': number;
  'github.reviewPromptTemplate': string;
  'github.updatePromptTemplate': string;
  'github.useCLI': boolean;

  'sentry.baseUrl': string;
  'sentry.organization': string;
  'sentry.projects': string[];
  'sentry.environment': string;
  'sentry.pathMappings': PathMapping[];

  'grafana.enabled': boolean;
  'grafana.baseUrl': string;
  'grafana.services': Record<string, string>;
  'grafana.serviceLabels': string[];
  'grafana.latency.datasourceUid': string;
  'grafana.latency.datasourceKind': 'prometheus' | 'loki';
  'grafana.latency.query': string;
  'grafana.latency.window': string;
  'grafana.latency.limit': number;

  'figma.enabled': boolean;

  'tasks.promptTemplate': string;
  'rows.titleLength': number;
  'refresh.minIntervalSeconds': number;

  /** Desktop only: how the queues are scoped. See DOCS.md §4, Workspaces. */
  'scope.mode': 'all' | 'folders' | 'workspace';
  'repos.folders': string[];
  'workspaces.list': { id: string; name: string; folders: string[] }[];
  'workspaces.active': string;

  /**
   * Where "Check it shipped" sends an agent to look, and what it signs in
   * with. The password and the basic-auth password are never settings —
   * they live in the SecretStore under `verify.password` /
   * `verify.basicPassword`, the same way a provider token does.
   */
  'verify.environment': string;
  'verify.site': string;
  'verify.username': string;
  'verify.basicAuth': boolean;
  'verify.basicUsername': string;
  /**
   * Environments and the test accounts on each (see `testAccounts.ts`). The
   * five `verify.*` keys above are the single environment this replaced;
   * they are read once to seed these and then left alone.
   */
  'verify.environments': TestEnvironment[];
  'verify.accounts': TestAccount[];
  /** Which environment "Check it shipped" preselects. */
  'verify.defaultEnvironment': string;

  'runner.default': string;
  'runner.custom': unknown[];
  'runner.reviewers': string[];
  /**
   * Per-kind model override, keyed by `RunKind` ("review", "unblock",
   * "verify", "implement"). Lets a stage that mostly reads and judges run on
   * a cheaper model than the one doing the actual implementation.
   */
  'runner.models': Record<string, string>;

  'notify.enabled': boolean;
  'launchAtLogin': boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  ticketKeyPattern: '[A-Z][A-Z0-9]+-\\d+',
  branchTemplate: '${key}-${slug}',

  'appearance.theme': 'system',
  'appearance.dayTheme': 'light',
  'appearance.nightTheme': 'dark',
  'appearance.dayStart': '07:00',
  'appearance.nightStart': '19:00',
  'appearance.accent': 'clay',
  'appearance.colorSafeStatus': false,
  'appearance.statusShapes': true,
  'appearance.density': 'comfortable',
  'appearance.terminalColors': 'integrated',

  'jira.baseUrl': '',
  'jira.email': '',
  'jira.jql': 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
  'jira.tasksJql':
    'assignee = currentUser() AND (statusCategory != Done OR resolutiondate >= -14d) ORDER BY updated DESC',
  'jira.inProgressTransition': '',
  'jira.tasksLimit': 100,

  'github.enabled': true,
  'github.baseUrl': 'https://api.github.com',
  'github.limit': 50,
  'github.reviewPromptTemplate': '',
  'github.updatePromptTemplate': '',
  'github.useCLI': false,

  'sentry.baseUrl': 'https://sentry.io',
  'sentry.organization': '',
  'sentry.projects': [],
  'sentry.environment': '',
  'sentry.pathMappings': [{ from: 'app:///', to: '' }],

  'grafana.enabled': true,
  'grafana.baseUrl': '',
  'grafana.services': {},
  'grafana.serviceLabels': ['service', 'app', 'job', 'namespace'],
  'grafana.latency.datasourceUid': '',
  'grafana.latency.datasourceKind': 'prometheus',
  'grafana.latency.query': '',
  'grafana.latency.window': '1h',
  'grafana.latency.limit': 5,

  'figma.enabled': true,

  'tasks.promptTemplate': '',
  'rows.titleLength': 40,
  'refresh.minIntervalSeconds': 15,

  'scope.mode': 'all',
  'repos.folders': [],
  'workspaces.list': [],
  'workspaces.active': '',

  'verify.environment': '',
  'verify.site': '',
  'verify.username': '',
  'verify.basicAuth': false,
  'verify.basicUsername': '',
  'verify.environments': [],
  'verify.accounts': [],
  'verify.defaultEnvironment': '',

  'runner.default': '',
  'runner.custom': [],
  'runner.reviewers': [],
  'runner.models': {},

  'notify.enabled': true,
  launchAtLogin: false
};

export type SettingKey = keyof Settings;
