/**
 * Activity history (spec section 9, /api/events).
 *
 * A small, capped, newest-first ring of events (restore start/finish, auto-heal
 * actions, suspensions, settings changes). Persisted to
 * ${DRP_DATA_DIR}/events.json when a data dir is provided (atomic tmp+rename);
 * purely in-memory otherwise (unit tests). Never throws on IO problems.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ActivityEvent, EventLevel } from './types.js';

const CAP = 200;

export class EventLog {
  private events: ActivityEvent[] = [];

  constructor(private readonly dataDir?: string) {
    if (dataDir) this.load();
  }

  private path(): string | null {
    return this.dataDir ? join(this.dataDir, 'events.json') : null;
  }

  private load(): void {
    const path = this.path();
    if (!path || !existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (Array.isArray(parsed)) {
        this.events = (parsed as ActivityEvent[]).slice(0, CAP);
      }
    } catch {
      /* corrupt file -> start empty rather than crash */
    }
  }

  private persist(): void {
    const path = this.path();
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.events), 'utf8');
      renameSync(tmp, path);
    } catch {
      /* best-effort persistence */
    }
  }

  add(level: EventLevel, kind: string, message: string): void {
    this.events.unshift({ at: new Date().toISOString(), level, kind, message });
    if (this.events.length > CAP) this.events.length = CAP;
    this.persist();
  }

  info(kind: string, message: string): void {
    this.add('info', kind, message);
  }

  warn(kind: string, message: string): void {
    this.add('warn', kind, message);
  }

  error(kind: string, message: string): void {
    this.add('error', kind, message);
  }

  list(): ActivityEvent[] {
    return this.events;
  }
}
