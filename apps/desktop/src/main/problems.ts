/**
 * The connection-problem log (item 120, option B), kept in the data folder so
 * earlier problems survive a restart. Fed by every published snapshot; see
 * `trackProblems` in core for what opens, counts and clears a problem.
 */

import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { trackProblems, type Problem, type ProviderId } from '@kovan/core';
import { EventEmitter } from '@kovan/host';

export class ProblemLog {
  private log: Problem[] = [];
  private loaded: Promise<void>;
  private readonly changed = new EventEmitter<{ log: Problem[]; started: Problem[] }>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly userData: string) {
    this.loaded = readFile(this.file, 'utf8')
      .then((text) => { const list = JSON.parse(text) as unknown; if (Array.isArray(list)) this.log = list as Problem[]; })
      .catch(() => undefined);
  }

  private get file(): string {
    return path.join(this.userData, 'problems.json');
  }

  async list(): Promise<Problem[]> {
    await this.loaded;
    return this.log;
  }

  /** One refresh's outcome: `answered` are the connected services that didn't fail. */
  async record(errors: { provider: ProviderId; message: string }[], answered: ProviderId[], at: number): Promise<void> {
    await this.loaded;
    const { log, started } = trackProblems(this.log, errors, answered, at);
    if (JSON.stringify(log) === JSON.stringify(this.log)) return;
    this.log = log;
    this.changed.fire({ log, started });
    await writeFile(this.file, JSON.stringify(log), 'utf8').catch(() => undefined);
  }
}
