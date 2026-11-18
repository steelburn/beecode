import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SkillStore } from './skills/store';
import { skillTools } from './tools/skills';

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'beecode-skills-home-'));
  const previous = process.env.BEECODE_HOME;
  process.env.BEECODE_HOME = home;
  try {
    await run(home);
  } finally {
    if (previous === undefined) delete process.env.BEECODE_HOME;
    else process.env.BEECODE_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

const FRONT_MATTER_SKILL = [
  '---',
  'name: Release Notes',
  'description: Turn a changelog into release notes.',
  '---',
  '',
  '# Release notes',
  '',
  'Group the commits by area, then write one line per change.',
].join('\n');

test('skill store discovers user and project skills', async () => {
  await withHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'beecode-skills-cwd-'));
    try {
      await mkdir(join(home, 'skills', 'release'), { recursive: true });
      await writeFile(join(home, 'skills', 'release', 'SKILL.md'), FRONT_MATTER_SKILL);

      await mkdir(join(cwd, '.beecode', 'skills', 'flat'), { recursive: true });
      await writeFile(join(cwd, '.beecode', 'skills', 'flat', 'SKILL.md'), '# Flat\n\nDo the flat thing.');
      await writeFile(
        join(cwd, '.beecode', 'skills', 'single.md'),
        '---\nname: single\ndescription: A one-file skill.\n---\nDo the thing.',
      );

      const store = new SkillStore();
      const skills = await store.load({ cwd });

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ['flat', 'release-notes', 'single'],
      );

      const release = store.get('Release Notes');
      assert.equal(release?.info.source, 'user');
      assert.equal(release?.info.description, 'Turn a changelog into release notes.');
      assert.match(release?.body ?? '', /^# Release notes/);
      // The front matter never reaches the model.
      assert.doesNotMatch(release?.body ?? '', /description:/);

      // Heading is the fallback name, first paragraph the fallback description.
      const flat = store.get('Flat');
      assert.equal(flat?.info.description, 'Do the flat thing.');

      assert.match(store.describe(), /release-notes \(user\)/);
      assert.match(store.describe(), /flat \(project\)/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test('a project skill overrides a user skill with the same name', async () => {
  await withHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'beecode-skills-cwd-'));
    try {
      await mkdir(join(home, 'skills', 'deploy'), { recursive: true });
      await writeFile(join(home, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: user copy\n---\nuser');

      await mkdir(join(cwd, 'playbooks', 'deploy'), { recursive: true });
      await writeFile(join(cwd, 'playbooks', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: project copy\n---\nproject');

      const store = new SkillStore();
      await store.load({ cwd, extraDirs: ['playbooks'] });

      assert.equal(store.list().length, 1);
      const deploy = store.get('deploy');
      assert.equal(deploy?.info.source, 'project');
      assert.equal(deploy?.info.description, 'project copy');
      assert.equal(deploy?.body, 'project');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test('skill tool lists, loads and rejects unknown skills', async () => {
  await withHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'beecode-skills-cwd-'));
    try {
      await mkdir(join(home, 'skills', 'demo'), { recursive: true });
      await writeFile(join(home, 'skills', 'demo', 'SKILL.md'), FRONT_MATTER_SKILL);

      const store = new SkillStore();
      const [tool] = skillTools({ store, scan: (dir) => store.ensure({ cwd: dir }) });
      const ctx = {
        sessionId: 'session-1',
        cwd,
        mode: 'ask' as const,
        workspaceRoots: [cwd],
        signal: new AbortController().signal,
        depth: 0,
      };

      const listed = JSON.parse((await tool.handler({}, ctx)).content) as {
        skills: Array<{ name: string }>;
      };
      assert.deepEqual(listed.skills.map((skill) => skill.name), ['release-notes']);

      const loaded = await tool.handler({ name: 'release-notes', input: 'v1.2.3' }, ctx);
      assert.match(loaded.content, /<skill name="release-notes" source="user">/);
      assert.match(loaded.content, /Group the commits by area/);
      assert.match(loaded.content, /v1\.2\.3/);
      assert.equal(loaded.failed, undefined);

      const missing = await tool.handler({ name: 'nope' }, ctx);
      assert.equal(missing.failed, true);
      assert.match(missing.content, /release-notes/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
