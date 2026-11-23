import type { Schedule } from '../../shared/protocol';
import { MISSED_GRACE_MS } from '../../shared/schedule';
import type { Logger } from '../logger';
import type { ScheduleStore } from './store';

/**
 * The timer behind the Scheduler panel and the `schedule` tool.
 *
 * It never owns a conversation: a due schedule is started as a *fresh* session, so a
 * background run cannot interleave with what the user is doing in their own chat, and
 * its transcript stays readable afterwards. Everything the runner learns about an
 * attempt is written back onto the schedule (`lastRunAt`, `lastResult`, `runCount`), so
 * the panel answers "did it run, and what happened" without a second store.
 */

export interface SchedulerRunnerDeps {
  store: ScheduleStore;
  log: Logger;
  /** Creates the run's session and enqueues its prompt; returns the session id. */
  start(schedule: Schedule): Promise<string>;
  /** Re-broadcasts the schedule list after a run updates it. */
  notify(schedules: Schedule[]): void;
  now?: () => Date;
  /** How often the timer looks for due schedules. */
  tickMs?: number;
}

const DEFAULT_TICK_MS = 30_000;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SchedulerRunner {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  /** Schedules whose session is being started — never fire the same one twice. */
  private readonly firing = new Set<string>();

  constructor(private readonly deps: SchedulerRunnerDeps) {}

  start(): void {
    if (this.timer) return;
    // Run one pass immediately: a schedule that came due while the app was closed should
    // not wait a full tick to be noticed.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.deps.tickMs ?? DEFAULT_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass over the store: fire what is due, record what was missed. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    let changed = false;
    try {
      const now = this.now();
      for (const schedule of await this.deps.store.list()) {
        if (!schedule.enabled || this.firing.has(schedule.id)) continue;
        const due = schedule.nextRunAt ? Date.parse(schedule.nextRunAt) : Number.NaN;
        if (!Number.isFinite(due) || due > now.getTime()) continue;
        await this.fire(schedule, due, now);
        changed = true;
      }
    } catch (error) {
      this.deps.log.warn(`scheduler tick failed: ${message(error)}`);
    } finally {
      this.ticking = false;
    }
    if (changed) await this.publish();
  }

  /** Fire one schedule immediately, whatever its next slot says (the panel's "Run now"). */
  async runNow(id: string): Promise<string> {
    const schedule = await this.deps.store.get(id);
    if (!schedule) throw new Error(`unknown schedule "${id}"`);
    const now = this.now();
    const sessionId = await this.deps.start(schedule);
    await this.deps.store.update(
      id,
      (entry) => {
        entry.lastRunAt = now.toISOString();
        entry.runCount += 1;
        entry.lastResult = `started session ${sessionId}`;
        if (entry.kind === 'once') entry.enabled = false;
      },
      now,
    );
    await this.publish();
    return sessionId;
  }

  private async fire(schedule: Schedule, due: number, now: Date): Promise<void> {
    this.firing.add(schedule.id);
    try {
      // A slot far in the past means the service was not running. Firing late would
      // surprise the user, so the run is recorded as missed and the rule advances.
      if (now.getTime() - due > MISSED_GRACE_MS) {
        this.deps.log.warn(
          `schedule "${schedule.name}" missed its ${new Date(due).toISOString()} slot`,
        );
        await this.deps.store.update(
          schedule.id,
          (entry) => {
            entry.lastResult = 'missed — the service was not running at that time';
          },
          now,
        );
        return;
      }
      const sessionId = await this.deps.start(schedule);
      await this.deps.store.update(
        schedule.id,
        (entry) => {
          entry.lastRunAt = now.toISOString();
          entry.runCount += 1;
          entry.lastResult = `started session ${sessionId}`;
          if (entry.kind === 'once') entry.enabled = false;
        },
        now,
      );
      this.deps.log.info(`schedule "${schedule.name}" started session ${sessionId}`);
    } catch (error) {
      this.deps.log.warn(`schedule "${schedule.name}" failed: ${message(error)}`);
      await this.deps.store
        .update(
          schedule.id,
          (entry) => {
            entry.lastResult = `error: ${message(error)}`;
          },
          now,
        )
        .catch(() => undefined);
    } finally {
      this.firing.delete(schedule.id);
    }
  }

  private async publish(): Promise<void> {
    this.deps.notify(await this.deps.store.list());
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}
