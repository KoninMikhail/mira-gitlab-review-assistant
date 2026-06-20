/**
 * Unit tests for the stack-profile loader (layer B guidance): frontmatter
 * stripping, lookup by optional name, idempotency fingerprints, fail-fast on
 * unknown names, and empty set for a missing directory. Uses a temp dir; no
 * network.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertProfilesResolvable, loadProfiles, ProfileError } from './profiles.ts';

function withProfilesDir(files: Record<string, string>, run: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'mira-profiles-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(path.join(dir, name), body);
    }
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

void test('loadProfiles strips frontmatter and returns the trimmed body', () => {
  withProfilesDir(
    {
      'python.md':
        '---\nprofile: python\nmatch_globs: ["**/*.py"]\n---\n\n# Python\n- mutable defaults\n',
      'java.md': '# Java\n- NPE risks\n',
      'notes.txt': 'ignored, not markdown',
    },
    (dir) => {
      const profiles = loadProfiles(dir);
      assert.deepEqual(profiles.names, ['java', 'python']);

      const py = profiles.guidanceFor('python');
      assert.ok(py);
      assert.ok(!py.includes('match_globs'), 'frontmatter should be stripped');
      assert.match(py, /# Python/);
      assert.match(py, /mutable defaults/);

      // A file without frontmatter is returned as-is.
      assert.match(profiles.guidanceFor('java') ?? '', /# Java/);
    },
  );
});

void test('loadProfiles: unset name yields undefined, version is stable per content', () => {
  withProfilesDir({ 'node.md': '# Node\n- await everything\n' }, (dir) => {
    const profiles = loadProfiles(dir);

    assert.equal(profiles.guidanceFor(undefined), undefined);
    assert.equal(profiles.versionFor(undefined), undefined);
    assert.equal(profiles.guidanceFor(''), undefined);

    const v = profiles.versionFor('node');
    assert.match(v ?? '', /^node@[0-9a-f]{8}$/);
    // Same content reloaded → same fingerprint.
    assert.equal(loadProfiles(dir).versionFor('node'), v);
  });
});

void test('loadProfiles: version changes when content changes', () => {
  let first: string | undefined;
  withProfilesDir({ 'node.md': '# Node v1' }, (dir) => {
    first = loadProfiles(dir).versionFor('node');
  });
  let second: string | undefined;
  withProfilesDir({ 'node.md': '# Node v2 changed' }, (dir) => {
    second = loadProfiles(dir).versionFor('node');
  });
  assert.notEqual(first, second);
});

void test('loadProfiles throws ProfileError for an unknown profile name', () => {
  withProfilesDir({ 'python.md': '# Python' }, (dir) => {
    const profiles = loadProfiles(dir);
    assert.throws(
      () => profiles.guidanceFor('rust'),
      (err: unknown) => {
        assert.ok(err instanceof ProfileError);
        assert.match(err.message, /Unknown review profile "rust"/);
        assert.match(err.message, /python/);
        return true;
      },
    );
  });
});

void test('loadProfiles returns an empty set for a missing directory', () => {
  const profiles = loadProfiles(path.join(tmpdir(), 'mira-does-not-exist-xyz'));
  assert.deepEqual(profiles.names, []);
  assert.equal(profiles.guidanceFor(undefined), undefined);
  assert.throws(() => profiles.versionFor('python'), ProfileError);
});

void test('assertProfilesResolvable passes for known names and throws otherwise', () => {
  withProfilesDir({ 'python.md': '# Python', 'node.md': '# Node' }, (dir) => {
    const profiles = loadProfiles(dir);
    assert.doesNotThrow(() => {
      assertProfilesResolvable(profiles, ['python', 'node']);
    });
    assert.throws(() => {
      assertProfilesResolvable(profiles, ['python', 'ghost']);
    }, ProfileError);
  });
});
