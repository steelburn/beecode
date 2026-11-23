import type { Schedule, ScheduleInput, ScheduleKind } from './protocol';

/**
 * Scheduling rules are pure data plus pure functions, kept here so the chat tool, the
 * Scheduler panel and the service timer all agree on what "daily at 09:00" means.
 *
 * Wall-clock rules (`daily`, `weekly`) resolve in the *local* time zone, because that is
 * what a user means by 09:00. `interval` is anchored on the last run so restarts do not
 * drift, and a long gap collapses into a single run instead of a burst.
 */

export const SCHEDULE_KINDS: readonly ScheduleKind[] = ['once', 'interval', 'daily', 'weekly'];

export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60;

/** A run whose slot is older than this is recorded as missed instead of fired late. */
export const MISSED_GRACE_MS = 60 * 60 * 1000;

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The timing part of a schedule, as produced by {@link parseWhen}. */
export interface TimingRule {
  kind: ScheduleKind;
  at?: string;
  everyMinutes?: number;
  time?: string;
  days?: number[];
}

/* ------------------------------------------------------------------ primitives */

/** `HH:MM` → minutes since local midnight; undefined when the text is not a clock time. */
export function parseClock(text: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return undefined;
  return hour * 60 + minute;
}

export function formatClock(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  return `${String(hour % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** `mon,thu` / `1,4` / `weekdays` → weekday numbers (0 = Sunday). */
export function parseDays(text: string): number[] {
  const raw = text.trim().toLowerCase();
  if (!raw) throw new Error('a weekly schedule needs at least one weekday');
  if (raw === 'weekdays') return [1, 2, 3, 4, 5];
  if (raw === 'weekend' || raw === 'weekends') return [0, 6];
  const days: number[] = [];
  for (const part of raw.split(/[,\s]+/).filter(Boolean)) {
    const asNumber = /^\d$/.test(part) ? Number(part) : -1;
    const asName = DAY_KEYS.indexOf(part.slice(0, 3));
    const day = asNumber >= 0 ? asNumber : asName;
    if (day < 0 || day > 6) throw new Error(`unknown weekday "${part}" (use mon…sun or 0…6)`);
    if (!days.includes(day)) days.push(day);
  }
  return days.sort((a, b) => a - b);
}

/** `30m` / `2h` / `1d` / `90` → minutes, clamped to the supported interval range. */
export function parseEvery(text: string): number {
  const match = /^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)?$/.exec(
    text.trim().toLowerCase(),
  );
  if (!match) throw new Error(`cannot read interval "${text}" (use e.g. 30m, 2h, 1d)`);
  const unit = match[2] ?? 'm';
  const factor = unit.startsWith('d') ? 1440 : unit.startsWith('h') ? 60 : 1;
  const minutes = Number(match[1]) * factor;
  if (minutes < MIN_INTERVAL_MINUTES)
    throw new Error(`the shortest interval is ${MIN_INTERVAL_MINUTES} minutes`);
  if (minutes > MAX_INTERVAL_MINUTES) throw new Error('the longest interval is 7 days');
  return minutes;
}

/** Local `YYYY-MM-DD HH:MM` (and `HH:MM`, `YYYY-MM-DD`) → ISO, interpreted in local time. */
export function toIsoMoment(text: string, now: Date = new Date()): string {
  const raw = text.trim();
  const clock = parseClock(raw);
  if (clock !== undefined) {
    const at = new Date(now);
    at.setSeconds(0, 0);
    at.setHours(Math.floor(clock / 60), clock % 60, 0, 0);
    // A bare clock time that already passed means tomorrow: "run at 09:00" is never past.
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    return at.toISOString();
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(raw);
  if (match) {
    const at = new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      match[4] === undefined ? 9 : Number(match[4]),
      match[5] === undefined ? 0 : Number(match[5]),
      0,
      0,
    );
    if (Number.isNaN(at.getTime())) throw new Error(`unknown date "${text}"`);
    return at.toISOString();
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`cannot read time "${text}" (use 2025-04-01 09:00, 09:00 or an ISO stamp)`);
  }
  return new Date(parsed).toISOString();
}

export function formatMoment(iso: string | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/* ------------------------------------------------------------------ timing rules */

/**
 * Reads a compact timing rule — the form the chat tool and the panel both produce:
 *
 *   once:2025-04-01 09:00 · once:09:00 · every:30m · every:2h · daily:09:00
 *   weekly:mon,thu@17:30 · weekly:weekdays@08:15
 */
export function parseWhen(text: string, now: Date = new Date()): TimingRule {
  const raw = text.trim();
  const colon = raw.indexOf(':');
  const space = raw.search(/\s/);
  const cut = colon < 0 ? space : space < 0 ? colon : Math.min(colon, space);
  const keyword = (cut < 0 ? raw : raw.slice(0, cut)).trim().toLowerCase();
  const value = cut < 0 ? '' : raw.slice(cut + 1).trim();

  switch (keyword) {
    case 'once':
      if (!value) throw new Error('once: needs a time, e.g. once:2025-04-01 09:00');
      return { kind: 'once', at: toIsoMoment(value, now) };
    case 'every':
    case 'interval':
      if (!value) throw new Error('every: needs an interval, e.g. every:30m');
      return { kind: 'interval', everyMinutes: parseEvery(value) };
    case 'daily': {
      const minutes = parseClock(value || '09:00');
      if (minutes === undefined) throw new Error(`cannot read the time in "${text}" (use HH:MM)`);
      return { kind: 'daily', time: formatClock(minutes) };
    }
    case 'weekly': {
      const [dayPart, timePart] = value.split('@');
      const days = parseDays(dayPart ?? '');
      const minutes = parseClock((timePart ?? '09:00').trim());
      if (minutes === undefined) throw new Error(`cannot read the time in "${text}" (use HH:MM)`);
      return { kind: 'weekly', days, time: formatClock(minutes) };
    }
    default:
      throw new Error(
        `unknown schedule "${text}" — use once:…, every:30m, daily:09:00 or weekly:mon,thu@17:30`,
      );
  }
}

/** One-line description used by the panel and by the chat tool's list output. */
export function describeSchedule(schedule: Schedule): string {
  switch (schedule.kind) {
    case 'once':
      return `Once on ${formatMoment(schedule.at)}`;
    case 'interval': {
      const minutes = schedule.everyMinutes ?? MIN_INTERVAL_MINUTES;
      if (minutes % 1440 === 0) return `Every ${minutes / 1440} day${minutes === 1440 ? '' : 's'}`;
      if (minutes % 60 === 0) return `Every ${minutes / 60} hour${minutes === 60 ? '' : 's'}`;
      return `Every ${minutes} minutes`;
    }
    case 'daily':
      return `Every day at ${schedule.time ?? '09:00'}`;
    case 'weekly': {
      const days = (schedule.days ?? []).map((day) => DAY_NAMES[day]?.slice(0, 3) ?? '?').join(', ');
      return `Weekly on ${days || '—'} at ${schedule.time ?? '09:00'}`;
    }
  }
}

/**
 * The next time a schedule should fire, computed forward from `from`.
 *
 * Returns undefined when nothing is left to do — an elapsed one-shot, or a weekly rule
 * with no weekday. An interval that has fallen behind restarts one interval from `from`
 * so a closed laptop produces one run, not the backlog.
 */
export function computeNextRun(schedule: Schedule, from: Date = new Date()): string | undefined {
  const now = from.getTime();
  switch (schedule.kind) {
    case 'once': {
      const at = schedule.at ? Date.parse(schedule.at) : NaN;
      return Number.isFinite(at) && at > now ? new Date(at).toISOString() : undefined;
    }
    case 'interval': {
      const minutes = Math.min(
        MAX_INTERVAL_MINUTES,
        Math.max(MIN_INTERVAL_MINUTES, schedule.everyMinutes ?? MIN_INTERVAL_MINUTES),
      );
      const every = minutes * 60_000;
      const anchor = Date.parse(schedule.lastRunAt ?? schedule.createdAt ?? '');
      const base = Number.isFinite(anchor) ? anchor : now;
      const candidate = base + every;
      return new Date(candidate > now ? candidate : now + every).toISOString();
    }
    case 'daily': {
      const minutes = parseClock(schedule.time ?? '09:00') ?? 9 * 60;
      const at = new Date(from);
      at.setHours(0, 0, 0, 0);
      at.setMinutes(minutes);
      if (at.getTime() <= now) at.setDate(at.getDate() + 1);
      return at.toISOString();
    }
    case 'weekly': {
      const days = schedule.days?.length ? schedule.days : [];
      if (!days.length) return undefined;
      const minutes = parseClock(schedule.time ?? '09:00') ?? 9 * 60;
      for (let offset = 0; offset <= 7; offset += 1) {
        const at = new Date(from);
        at.setHours(0, 0, 0, 0);
        at.setDate(at.getDate() + offset);
        at.setMinutes(minutes);
        if (!days.includes(at.getDay())) continue;
        if (at.getTime() <= now) continue;
        return at.toISOString();
      }
      return undefined;
    }
  }
}

/* ------------------------------------------------------------------ mutation */

function newScheduleId(now: Date): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `sch_${now.getTime().toString(36)}${random}`;
}

function withTiming(schedule: Schedule, rule: TimingRule): Schedule {
  // The four timing fields are one unit: replacing the rule must drop the old fields,
  // otherwise a `daily` schedule keeps a stale `everyMinutes` that a later edit could revive.
  return {
    ...schedule,
    kind: rule.kind,
    at: rule.at,
    everyMinutes: rule.everyMinutes,
    time: rule.time,
    days: rule.days,
  };
}

/**
 * Folds a create/update payload onto a schedule (or a blank one) and re-derives
 * `nextRunAt`. Throws on anything the user has to fix, with a message meant for chat.
 */
export function applyScheduleInput(
  existing: Schedule | undefined,
  input: ScheduleInput,
  now: Date = new Date(),
): Schedule {
  const name = (input.name ?? existing?.name ?? '').trim();
  const prompt = (input.prompt ?? existing?.prompt ?? '').trim();
  if (!name) throw new Error('a schedule needs a name');
  if (!prompt) throw new Error('a schedule needs a prompt');

  const stamp = now.toISOString();
  let schedule: Schedule = existing ?? {
    id: newScheduleId(now),
    name,
    prompt,
    kind: 'daily',
    time: '09:00',
    mode: 'act',
    enabled: true,
    createdAt: stamp,
    updatedAt: stamp,
    runCount: 0,
  };

  schedule = { ...schedule, name: name.slice(0, 120), prompt: prompt.slice(0, 4000) };
  if (input.when) schedule = withTiming(schedule, parseWhen(input.when, now));
  if (input.mode) schedule.mode = input.mode;
  if (input.cwd !== undefined) schedule.cwd = input.cwd.trim() || undefined;
  if (input.enabled !== undefined) schedule.enabled = input.enabled;

  if (!existing && !input.when) {
    throw new Error('a new schedule needs when:, e.g. daily:09:00 or every:30m');
  }
  if (schedule.kind === 'weekly' && !schedule.days?.length) {
    throw new Error('a weekly schedule needs days, e.g. weekly:mon,thu@17:30');
  }
  if (schedule.kind === 'once' && !schedule.at) {
    throw new Error('a once schedule needs a time, e.g. once:2025-04-01 09:00');
  }
  if (schedule.kind === 'daily' && !schedule.time) schedule.time = '09:00';

  schedule.updatedAt = stamp;
  schedule.nextRunAt = schedule.enabled ? computeNextRun(schedule, now) : undefined;
  return schedule;
}

/** Soonest first, then by name — the order the panel and the tool both show. */
export function sortSchedules(schedules: Schedule[]): Schedule[] {
  return [...schedules].sort((a, b) => {
    const left = a.nextRunAt ? Date.parse(a.nextRunAt) : Number.POSITIVE_INFINITY;
    const right = b.nextRunAt ? Date.parse(b.nextRunAt) : Number.POSITIVE_INFINITY;
    if (left !== right) return left - right;
    return a.name.localeCompare(b.name);
  });
}
