import { join } from 'node:path';
import type { Schedule, ScheduleInput, ScheduleKind } from '../../shared/protocol';
import { applyScheduleInput, computeNextRun, sortSchedules } from '../../shared/schedule';
import { paths } from '../../shared/tools';
import { readJsonFile, writeJsonFile } from '../logger';

/**
 * Schedules on disk, in the user's beeCode home folder next to the other stores.
 *
 * The file is the single source of truth: the chat tool, the Scheduler panel and the
 * service timer all read and write through this class, so an edit made in one place is
 * what the others see on their next read. Every write re-derives `nextRunAt` — a schedule
 * saved with a stale fire time would either fire immediately or never.
 */

const FILE_VERSION = 1;
const KINDS: ReadonlySet<string> = new Set<ScheduleKind>(['once', 'interval', 'daily', 'weekly']);

interface ScheduleFile {
  version: number;
  schedules: Schedule[];
}

/** Only structurally sound records survive a hand-edited or half-written file. */
function isSchedule(value: unknown): value is Schedule {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    typeof record.prompt === 'string' &&
    typeof record.kind === 'string' &&
    KINDS.has(record.kind)
  );
}

export class ScheduleStore {
  private cache?: Schedule[];

  constructor(private readonly file: string = join(paths().home, 'scheduler.json')) {}

  /** Every schedule, soonest fire time first. */
  async list(): Promise<Schedule[]> {
    return sortSchedules(await this.read());
  }

  async get(id: string): Promise<Schedule | undefined> {
    return (await this.read()).find((schedule) => schedule.id === id);
  }

  /** Create (no `id`) or update (with `id`) one schedule. */
  async save(
    input: ScheduleInput,
    now: Date = new Date(),
  ): Promise<{ schedule: Schedule; schedules: Schedule[] }> {
    const schedules = await this.read();
    const index = input.id ? schedules.findIndex((schedule) => schedule.id === input.id) : -1;
    if (input.id && index < 0) throw new Error(`unknown schedule "${input.id}"`);
    const schedule = applyScheduleInput(index >= 0 ? schedules[index] : undefined, input, now);
    if (index >= 0) schedules[index] = schedule;
    else schedules.push(schedule);
    return { schedule, schedules: await this.write(schedules) };
  }

  async remove(id: string): Promise<Schedule[]> {
    const schedules = await this.read();
    const next = schedules.filter((schedule) => schedule.id !== id);
    if (next.length === schedules.length) throw new Error(`unknown schedule "${id}"`);
    return this.write(next);
  }

  /**
   * Mutate one schedule in place and persist it. `nextRunAt` is re-derived from the
   * mutated record, so a run that just happened moves to its following slot.
   */
  async update(
    id: string,
    mutate: (schedule: Schedule) => void,
    now: Date = new Date(),
  ): Promise<Schedule | undefined> {
    const schedules = await this.read();
    const schedule = schedules.find((entry) => entry.id === id);
    if (!schedule) return undefined;
    mutate(schedule);
    schedule.updatedAt = now.toISOString();
    schedule.nextRunAt = schedule.enabled ? computeNextRun(schedule, now) : undefined;
    await this.write(schedules);
    return schedule;
  }

  private async read(): Promise<Schedule[]> {
    if (this.cache) return this.cache;
    const raw = await readJsonFile<ScheduleFile | Schedule[]>(this.file, {
      version: FILE_VERSION,
      schedules: [],
    });
    const list = Array.isArray(raw) ? raw : (raw.schedules ?? []);
    this.cache = list.filter(isSchedule);
    return this.cache;
  }

  private async write(schedules: Schedule[]): Promise<Schedule[]> {
    this.cache = sortSchedules(schedules);
    await writeJsonFile(this.file, { version: FILE_VERSION, schedules: this.cache });
    return this.cache;
  }
}
