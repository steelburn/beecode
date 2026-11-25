import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SLATE_SUBMIT_LIMITS,
  normaliseSlateSubmit,
  slateSubmitLabel,
  validateSlateSubmission,
} from './slateSubmit';

const schema = normaliseSlateSubmit({
  note: 'sends the hours',
  fields: [
    { name: 'hours', type: 'number', required: true },
    { name: 'comment', type: 'textarea', maxLength: 12 },
    { name: 'team', type: 'select', options: ['red', 'blue'] },
    { name: 'billable', type: 'checkbox' },
  ],
});
assert.ok(schema);

test('a slate that declares no form has no schema, and an empty one is refused', () => {
  assert.equal(normaliseSlateSubmit(undefined), undefined);
  assert.equal(normaliseSlateSubmit(null), undefined);
  assert.throws(() => normaliseSlateSubmit({ fields: [] }), /non-empty array/);
  assert.throws(() => normaliseSlateSubmit({ note: 'x' }), /fields/);
  assert.throws(() => normaliseSlateSubmit('form'), /object/);
});

test('field names have to survive being JSON keys', () => {
  assert.throws(() => normaliseSlateSubmit({ fields: [{ name: 'Hours' }] }), /not usable/);
  assert.throws(() => normaliseSlateSubmit({ fields: [{ name: '2hours' }] }), /not usable/);
  assert.throws(() => normaliseSlateSubmit({ fields: [{ name: 'a-b' }] }), /not usable/);
  assert.throws(
    () => normaliseSlateSubmit({ fields: [{ name: 'a' }, { name: 'a' }] }),
    /declared twice/,
  );
});

test('a select without options, an unknown type and too many fields are refused', () => {
  assert.throws(() => normaliseSlateSubmit({ fields: [{ name: 'a', type: 'select' }] }), /options/);
  assert.throws(() => normaliseSlateSubmit({ fields: [{ name: 'a', type: 'date' }] }), /one of/);
  const many = Array.from({ length: SLATE_SUBMIT_LIMITS.fields + 1 }, (_, n) => ({ name: `f${n}` }));
  assert.throws(() => normaliseSlateSubmit({ fields: many }), /at most/);
});

test('the schema is normalised: defaults filled in, maxLength capped', () => {
  assert.deepEqual(schema.fields[0], { name: 'hours', type: 'number', required: true });
  assert.equal(schema.fields[1].maxLength, 12);
  assert.deepEqual(schema.fields[2].options, ['red', 'blue']);
  assert.equal(schema.fields[3].required, undefined);
  assert.equal(slateSubmitLabel(schema), 'may send form results back to the app (4 fields)');
});

test('a fitting submission comes back as plain fields', () => {
  const checked = validateSlateSubmission(schema, {
    fields: { hours: 7.5, comment: 'ok', team: 'blue', billable: true },
  });
  assert.deepEqual(checked, {
    ok: true,
    fields: { hours: 7.5, comment: 'ok', team: 'blue', billable: true },
  });
});

test('optional fields may be left out; required ones may not', () => {
  assert.deepEqual(validateSlateSubmission(schema, { fields: { hours: 1 } }), {
    ok: true,
    fields: { hours: 1 },
  });
  const missing = validateSlateSubmission(schema, { fields: { comment: 'hi' } });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.ok === false && missing.errors, [
    { field: 'hours', message: 'this field is required' },
  ]);
});

test('values are never coerced and unknown fields are refused, not ignored', () => {
  assert.deepEqual(validateSlateSubmission(schema, { fields: { hours: '7' } }), {
    ok: false,
    errors: [{ field: 'hours', message: 'expected a number' }],
  });
  assert.deepEqual(validateSlateSubmission(schema, { fields: { hours: 1, billable: 'yes' } }), {
    ok: false,
    errors: [{ field: 'billable', message: 'expected true or false' }],
  });
  assert.deepEqual(validateSlateSubmission(schema, { fields: { hours: 1, team: 'green' } }), {
    ok: false,
    errors: [{ field: 'team', message: 'expected one of red, blue' }],
  });
  assert.deepEqual(validateSlateSubmission(schema, { fields: { hours: 1, extra: 'x' } }), {
    ok: false,
    errors: [{ field: 'extra', message: 'this field is not declared by the slate' }],
  });
});

test('a text field respects its own maxLength, not the global one', () => {
  const long = validateSlateSubmission(schema, { fields: { hours: 1, comment: 'x'.repeat(13) } });
  assert.deepEqual(long, { ok: false, errors: [{ field: 'comment', message: 'longer than 12 characters' }] });
});

test('a submission that is not shaped like one is refused before any field is read', () => {
  assert.equal(validateSlateSubmission(schema, undefined).ok, false);
  assert.equal(validateSlateSubmission(schema, { values: {} }).ok, false);
  assert.equal(validateSlateSubmission(schema, []).ok, false);
});
