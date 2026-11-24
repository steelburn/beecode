import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { SlateStore } from './slates';
import { promoteFences } from './slatePromote';

const roots: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'beecode-promote-'));
  roots.push(root);
  return root;
}

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const PAGE = [
  '<!doctype html>',
  '<html>',
  '<head><title>Sales Q3</title></head>',
  '<body>',
  ...Array.from({ length: 42 }, (_, i) => `<p>row ${i}</p>`),
  '</body>',
  '</html>',
].join('\n');

function message(body: string, info = 'html'): string {
  return ['Here is the dashboard.', '', `\`\`\`${info}`, body, '```', '', 'Open it in the slates tab.'].join('\n');
}

test('a long html block becomes a slate and leaves the prose behind', async () => {
  const cwd = await workspace();
  const store = new SlateStore();
  const location = { cwd, sessionId: 'session-1' };

  const result = await promoteFences(store, location, message(PAGE));

  assert.equal(result.refs.length, 1);
  assert.equal(result.refs[0].title, 'Sales Q3');
  assert.equal(result.refs[0].kind, 'html');
  assert.equal(result.refs[0].version, 1);
  assert.equal(result.refs[0].versions, 1);
  assert.equal(result.text, 'Here is the dashboard.\n\nOpen it in the slates tab.');

  const stored = await store.read({ ...location, id: result.refs[0].id, version: 1 });
  assert.ok(stored.content.includes('<p>row 41</p>'));
  assert.ok(!stored.content.includes('```'));
});

test('a short block is left where it is', async () => {
  const cwd = await workspace();
  const store = new SlateStore();
  const text = message('<p>one</p>');
  const result = await promoteFences(store, { cwd, sessionId: 's' }, text);
  assert.deepEqual(result.refs, []);
  assert.equal(result.text, text);
});

test('two blocks in one message become two slates', async () => {
  const cwd = await workspace();
  const store = new SlateStore();
  const text = [
    '```html',
    PAGE,
    '```',
    'Between them.',
    '```svg',
    ...Array.from({ length: 44 }, (_, i) => `<rect y="${i}" />`),
    '</svg>',
    '```',
  ].join('\n');

  const result = await promoteFences(store, { cwd, sessionId: 's' }, text);
  assert.equal(result.refs.length, 2);
  assert.equal(result.refs[0].title, 'Sales Q3');
  assert.equal(result.refs[1].title, 'SVG image');
  assert.equal(result.text, 'Between them.');
});

test('a refused slate leaves its block inline and keeps going', async () => {
  const cwd = await workspace();
  const real = new SlateStore();
  const refusals: string[] = [];
  const store = {
    create: async (input: { title: string }) => {
      if (input.title === 'Sales Q3') throw new Error('too many slates in this session');
      return real.create(input as never);
    },
  };

  const result = await promoteFences(store as never, { cwd, sessionId: 's' }, message(PAGE), (title, reason) =>
    refusals.push(`${title}: ${reason}`),
  );

  assert.deepEqual(result.refs, []);
  assert.equal(result.text, message(PAGE));
  assert.deepEqual(refusals, ['Sales Q3: too many slates in this session']);
});
