/**
 * The one channel a live slate has back into the app.
 *
 * A live slate can already POST to an origin on its allowlist. This is the *local* channel:
 * the page posts to `slate://live/<session>/<id>/v<N>/submit` — the same origin it was
 * served from, one path deeper. It is deliberately tiny: one endpoint, one payload shape
 * (`{ fields }`), and no return value beyond ok/errors. The moment a page can name a
 * method, authored HTML becomes a client for every tool in the service and the whole
 * "no preload, therefore no bridge" argument inverts.
 *
 * The declared schema is the contract between the page and the sink. It is what the
 * approval card prints, what the host validates against, and what decides whether
 * `connect-src` gains `'self'` at all — a slate that declares no schema keeps
 * `connect-src 'none'` exactly as before.
 *
 * Nothing here talks to Electron or to the filesystem: it is the shared vocabulary of the
 * tool, the store, the host and the tests.
 */

export type SlateSubmitFieldType = 'text' | 'textarea' | 'number' | 'checkbox' | 'select';

export const SLATE_SUBMIT_FIELD_TYPES: readonly SlateSubmitFieldType[] = [
  'text',
  'textarea',
  'number',
  'checkbox',
  'select',
];

/** One field of a declared form. Names are the keys the page posts back. */
export interface SlateSubmitField {
  /** `^[a-z][a-zA-Z0-9_]*$`, at most 40 characters — it has to survive path-free JSON. */
  name: string;
  label?: string;
  type: SlateSubmitFieldType;
  required?: boolean;
  /** `select` only: the closed set of accepted values. */
  options?: string[];
  /** `text`/`textarea` only; capped by `SLATE_SUBMIT_LIMITS.maxLength`. */
  maxLength?: number;
}

export interface SlateSubmitSchema {
  fields: SlateSubmitField[];
  /** One line for the approval card, e.g. "Sends the weekly hours to the agent". */
  note?: string;
}

/** A rejection the page can act on: which field was wrong, and why. */
export interface SlateSubmitError {
  field: string;
  message: string;
}

export type SlateSubmitValue = string | number | boolean;

/** One accepted submission, as it is appended to the sink. */
export interface SlateSubmission {
  /** 1-based arrival order within the slate. */
  n: number;
  /** The page's idempotency key, so a retry is not a second submission. */
  id: string;
  at: string;
  /** The version whose schema this validated against. */
  version: number;
  fields: Record<string, SlateSubmitValue>;
}

/**
 * The caps that keep a form from becoming a database. Like the slate caps they are
 * refusals, never pruning: nothing a page posted is dropped silently.
 */
export const SLATE_SUBMIT_LIMITS = {
  fields: 24,
  options: 40,
  maxLength: 4000,
  /** One payload, as JSON text. */
  bytes: 64 * 1024,
  /** Submissions kept per slate; past this the sink refuses and says so. */
  submissions: 200,
  /** Length of the page's idempotency key. */
  idLength: 64,
} as const;

const FIELD_NAME = /^[a-z][a-zA-Z0-9_]{0,39}$/;
const MAX_LABEL = 80;
const MAX_NOTE = 200;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Validate a declared schema. Throws when it is unusable: unlike a submission, a schema is
 * written once by the agent at create/update time, so a wrong one is a bug to fix rather
 * than something to report back field by field.
 */
export function normaliseSlateSubmit(input: unknown): SlateSubmitSchema | undefined {
  if (input === undefined || input === null) return undefined;
  const raw = asRecord(input);
  if (!raw) throw new Error('submit must be an object with a fields array');

  const fields = raw.fields;
  if (!Array.isArray(fields) || !fields.length) {
    throw new Error('submit.fields must be a non-empty array — omit submit entirely for a slate that takes no input');
  }
  if (fields.length > SLATE_SUBMIT_LIMITS.fields) {
    throw new Error(
      `a slate form may declare at most ${SLATE_SUBMIT_LIMITS.fields} fields (this one declares ${fields.length})`,
    );
  }

  const seen = new Set<string>();
  const out: SlateSubmitField[] = [];
  for (const entry of fields) {
    const field = asRecord(entry);
    if (!field) throw new Error('every submit.fields entry must be an object');
    const name = typeof field.name === 'string' ? field.name.trim() : '';
    if (!FIELD_NAME.test(name)) {
      throw new Error(
        `submit field name "${name}" is not usable — lowercase letters, digits and _, starting with a letter`,
      );
    }
    if (seen.has(name)) throw new Error(`submit field "${name}" is declared twice`);
    seen.add(name);
    const type = field.type === undefined ? 'text' : String(field.type);
    if (!SLATE_SUBMIT_FIELD_TYPES.includes(type as SlateSubmitFieldType)) {
      throw new Error(
        `submit field "${name}" has type "${type}" — one of ${SLATE_SUBMIT_FIELD_TYPES.join(', ')}`,
      );
    }
    const normalised: SlateSubmitField = { name, type: type as SlateSubmitFieldType };
    if (typeof field.label === 'string' && field.label.trim()) {
      normalised.label = field.label.trim().slice(0, MAX_LABEL);
    }
    if (field.required === true) normalised.required = true;
    if (type === 'select') {
      const options = Array.isArray(field.options) ? field.options : [];
      const values = options
        .map((option) => (typeof option === 'string' ? option.trim() : ''))
        .filter((option) => option.length > 0);
      if (!values.length) throw new Error(`submit field "${name}" is a select without options`);
      if (values.length > SLATE_SUBMIT_LIMITS.options) {
        throw new Error(
          `submit field "${name}" offers ${values.length} options — the limit is ${SLATE_SUBMIT_LIMITS.options}`,
        );
      }
      normalised.options = values;
    }
    if (type === 'text' || type === 'textarea') {
      const maxLength = Number(field.maxLength ?? SLATE_SUBMIT_LIMITS.maxLength);
      if (!Number.isFinite(maxLength) || maxLength < 1) {
        throw new Error(`submit field "${name}" has an unusable maxLength`);
      }
      normalised.maxLength = Math.min(Math.floor(maxLength), SLATE_SUBMIT_LIMITS.maxLength);
    }
    out.push(normalised);
  }

  const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, MAX_NOTE) : '';
  return note ? { fields: out, note } : { fields: out };
}

const rejection = (errors: SlateSubmitError[]): { ok: false; errors: SlateSubmitError[] } => ({
  ok: false,
  errors,
});

/**
 * Check one posted payload against the schema the hosted version declared.
 *
 * Strict on purpose: unknown keys are rejected rather than ignored, values are never
 * coerced, and the result is a plain object the sink can append as-is. What comes in is
 * untrusted authored HTML, so "close enough" is not a validation strategy.
 */
export function validateSlateSubmission(
  schema: SlateSubmitSchema,
  payload: unknown,
): { ok: true; fields: Record<string, SlateSubmitValue> } | { ok: false; errors: SlateSubmitError[] } {
  const raw = asRecord(payload);
  if (!raw) return rejection([{ field: '', message: 'the submission must be an object' }]);
  const posted = asRecord(raw.fields);
  if (!posted) return rejection([{ field: 'fields', message: 'the submission must carry a fields object' }]);

  const declared = new Set(schema.fields.map((field) => field.name));
  const unknown = Object.keys(posted).filter((key) => !declared.has(key));
  if (unknown.length) {
    return rejection(unknown.map((key) => ({ field: key, message: 'this field is not declared by the slate' })));
  }

  const errors: SlateSubmitError[] = [];
  const fields: Record<string, SlateSubmitValue> = {};

  for (const field of schema.fields) {
    const value = posted[field.name];
    const missing = value === undefined || value === null || value === '';
    if (missing) {
      if (field.required) errors.push({ field: field.name, message: 'this field is required' });
      continue;
    }
    if (field.type === 'checkbox') {
      if (typeof value !== 'boolean') {
        errors.push({ field: field.name, message: 'expected true or false' });
        continue;
      }
      fields[field.name] = value;
      continue;
    }
    if (field.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push({ field: field.name, message: 'expected a number' });
        continue;
      }
      fields[field.name] = value;
      continue;
    }
    if (typeof value !== 'string') {
      errors.push({ field: field.name, message: 'expected text' });
      continue;
    }
    if (field.type === 'select') {
      if (!field.options?.includes(value)) {
        errors.push({
          field: field.name,
          message: `expected one of ${(field.options ?? []).join(', ')}`,
        });
        continue;
      }
      fields[field.name] = value;
      continue;
    }
    const limit = field.maxLength ?? SLATE_SUBMIT_LIMITS.maxLength;
    if (value.length > limit) {
      errors.push({ field: field.name, message: `longer than ${limit} characters` });
      continue;
    }
    fields[field.name] = value;
  }

  if (errors.length) return rejection(errors);
  return { ok: true, fields };
}

/** How the approval card describes a form, in the same breath as its origins. */
export function slateSubmitLabel(schema: SlateSubmitSchema): string {
  const count = schema.fields.length;
  return `may send form results back to the app (${count} field${count === 1 ? '' : 's'})`;
}
