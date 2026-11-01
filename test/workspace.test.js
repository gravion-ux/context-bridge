'use strict';

/**
 * Tests for the filesystem and Git layer.
 *
 * This module used to live inside `src/extension.js` and had no coverage at
 * all. It was extracted into `src/workspace.js` so it can be tested without a
 * VS Code host.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');

const {
  HANDOFF_DIR,
  HANDOFF_PREFIX,
  NOTES_FILE,
  appendProjectNote,
  collectGitContext,
  collectWorkspaceEntries,
  isInsideWorkspace,
  latestHandoffPath,
  parseHandoffName,
  readProjectNotes,
  runGit,
  saveHandoff,
  timestampSlug,
} = require('../src/workspace');

async function scratch() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'gcb-test-'));
}

async function write(root, relative, content = 'x') {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
  return target;
}

async function symlinksAvailable() {
  const root = await scratch();
  try {
    await fs.symlink(path.join(root, 'target'), path.join(root, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Workspace listing
// ---------------------------------------------------------------------------

test('collects a sorted, bounded listing of the workspace', async () => {
  const root = await scratch();
  await write(root, 'src/index.js');
  await write(root, 'README.md');

  const { entries } = await collectWorkspaceEntries(root, 4, 200);
  const paths = entries.map((entry) => entry.path);

  assert.ok(paths.includes('README.md'));
  assert.ok(paths.includes('src'));
  assert.ok(paths.includes('src/index.js'));
  assert.deepEqual(paths, [...paths].sort(), 'entries are sorted');
});

test('labels directories and files', async () => {
  const root = await scratch();
  await write(root, 'src/index.js');

  const { entries } = await collectWorkspaceEntries(root, 4, 200);

  assert.deepEqual(
    entries.find((entry) => entry.path === 'src'),
    { path: 'src', kind: 'directory' }
  );
  assert.deepEqual(
    entries.find((entry) => entry.path === 'src/index.js'),
    { path: 'src/index.js', kind: 'file' }
  );
});

test('GCB-08: the extension own directory is never listed', async () => {
  const root = await scratch();
  await write(root, '.gravion/handoffs/handoff-20260101-000000-000.md');
  await write(root, '.gravion/project-notes.md');
  await write(root, 'src/index.js');

  const { entries } = await collectWorkspaceEntries(root, 4, 200);
  const paths = entries.map((entry) => entry.path);

  assert.deepEqual(paths.filter((p) => p.startsWith('.gravion')), []);
  assert.ok(paths.includes('src/index.js'));
});

test('dependency directories and credential files are skipped', async () => {
  const root = await scratch();
  await write(root, 'node_modules/pkg/index.js');
  await write(root, 'NODE_MODULES/other/index.js');
  await write(root, '.env');
  await write(root, 'credentials.json');
  await write(root, 'src/index.js');

  const { entries } = await collectWorkspaceEntries(root, 4, 200);
  const paths = entries.map((entry) => entry.path);

  assert.deepEqual(paths.filter((p) => p.toLowerCase().includes('node_modules')), []);
  assert.deepEqual(paths.filter((p) => p === '.env' || p === 'credentials.json'), []);
  assert.ok(paths.includes('src/index.js'));
});

test('the listing honours the depth limit', async () => {
  const root = await scratch();
  await write(root, 'a/b/c/d/file.txt');

  const shallow = await collectWorkspaceEntries(root, 1, 200);
  const deep = await collectWorkspaceEntries(root, 5, 200);

  assert.ok(!shallow.entries.some((entry) => entry.path === 'a/b/c/d/file.txt'));
  assert.ok(deep.entries.some((entry) => entry.path === 'a/b/c/d/file.txt'));
});

test('the listing honours the entry cap', async () => {
  const root = await scratch();
  for (let i = 0; i < 10; i += 1) {
    await write(root, `file-${i}.txt`);
  }

  const { entries } = await collectWorkspaceEntries(root, 4, 5);

  assert.equal(entries.length, 5);
});

test('GCB-08: a directory that cannot be read is reported, not silently dropped', async () => {
  const root = await scratch();
  await write(root, 'ok/file.txt');

  const { entries, skipped } = await collectWorkspaceEntries(root, 4, 200);

  assert.ok(entries.some((entry) => entry.path === 'ok/file.txt'));
  assert.ok(Array.isArray(skipped));
});

test('symbolic links are never listed or followed', async () => {
  if (!await symlinksAvailable()) {
    return;
  }
  const root = await scratch();
  const outside = await scratch();
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret', 'utf8');
  await write(root, 'real/file.txt');
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'), 'file');
  await fs.symlink(outside, path.join(root, 'linkdir'), 'dir');

  const { entries } = await collectWorkspaceEntries(root, 4, 200);
  const paths = entries.map((entry) => entry.path);

  assert.ok(!paths.includes('link.txt'));
  assert.ok(!paths.includes('linkdir'));
  assert.ok(!paths.some((p) => p.includes('secret.txt')));

  await fs.rm(outside, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Handoff files
// ---------------------------------------------------------------------------

test('GCB-05: two handoffs in the same millisecond never overwrite each other', async () => {
  const root = await scratch();
  const now = new Date('2026-01-01T00:00:00.123Z');

  const first = await saveHandoff(root, 'FIRST', { now });
  const second = await saveHandoff(root, 'SECOND', { now });

  assert.notEqual(first, second);
  assert.equal(await fs.readFile(first, 'utf8'), 'FIRST');
  assert.equal(await fs.readFile(second, 'utf8'), 'SECOND');
});

test('saveHandoff writes under .gravion/handoffs with the expected prefix', async () => {
  const root = await scratch();

  const filePath = await saveHandoff(root, 'body');

  assert.ok(filePath.startsWith(path.join(root, HANDOFF_DIR)));
  assert.ok(path.basename(filePath).startsWith(HANDOFF_PREFIX));
  assert.match(path.basename(filePath), /\.md$/);
});

test('GCB-05: the latest handoff is the newest one, not an arbitrary one', async () => {
  const root = await scratch();
  const older = await saveHandoff(root, 'older', { now: new Date('2026-01-01T00:00:00.000Z') });
  const newer = await saveHandoff(root, 'newer', { now: new Date('2026-01-02T00:00:00.000Z') });
  await write(root, path.join(HANDOFF_DIR, 'unrelated.md'), 'not a handoff');

  const latest = await latestHandoffPath(root);

  assert.equal(latest, newer);
  assert.notEqual(latest, older);
});

test('latestHandoffPath returns undefined when there is no handoff', async () => {
  const root = await scratch();

  assert.equal(await latestHandoffPath(root), undefined);
});

test('parseHandoffName orders names by timestamp and attempt', () => {
  const plain = parseHandoffName('handoff-20260101-000000.md');
  const withMillis = parseHandoffName('handoff-20260101-000000-500.md');
  const attempt = parseHandoffName('handoff-20260101-000000-500-1.md');
  const later = parseHandoffName('handoff-20260101-000001-000.md');

  assert.ok(plain);
  assert.ok(withMillis.stamp > plain.stamp);
  assert.equal(attempt.stamp, withMillis.stamp);
  assert.ok(attempt.attempt > withMillis.attempt);
  assert.ok(later.stamp > attempt.stamp);
  assert.equal(parseHandoffName('readme.md'), undefined);
});

test('timestampSlug sorts chronologically and carries milliseconds', () => {
  const first = timestampSlug(new Date(2026, 0, 2, 3, 4, 5, 6));
  const second = timestampSlug(new Date(2026, 0, 2, 3, 4, 5, 7));

  assert.match(first, /^20260102-030405-006$/);
  assert.ok(second > first);
});

// ---------------------------------------------------------------------------
// Workspace containment
// ---------------------------------------------------------------------------

test('isInsideWorkspace accepts a file in the workspace', async () => {
  const root = await scratch();
  const file = await write(root, 'src/index.js');

  assert.equal(await isInsideWorkspace(root, file), true);
});

test('isInsideWorkspace rejects a file outside the workspace', async () => {
  const root = await scratch();
  const outside = await scratch();
  const file = await write(outside, 'secret.txt');

  assert.equal(await isInsideWorkspace(root, file), false);
  assert.equal(await isInsideWorkspace(root, root), false);
});

test('GCB-13: a symbolic link inside the workspace that points outside is rejected', async () => {
  if (!await symlinksAvailable()) {
    return;
  }
  const root = await scratch();
  const outside = await scratch();
  const target = await write(outside, 'secret.txt');
  const link = path.join(root, 'link.txt');
  await fs.symlink(target, link, 'file');

  assert.equal(await isInsideWorkspace(root, link), false);

  await fs.rm(outside, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Project notes
// ---------------------------------------------------------------------------

test('appendProjectNote appends and keeps the existing content', async () => {
  const root = await scratch();
  const now = new Date('2026-01-01T00:00:00.000Z');

  await appendProjectNote(root, 'first note', { now });
  await appendProjectNote(root, 'second note', { now: new Date('2026-01-02T00:00:00.000Z') });

  const notes = await readProjectNotes(root);

  assert.match(notes, /first note/);
  assert.match(notes, /second note/);
  assert.ok(notes.indexOf('first note') < notes.indexOf('second note'));
});

test('appendProjectNote writes to the documented path', async () => {
  const root = await scratch();

  await appendProjectNote(root, 'a note');

  const written = await fs.readFile(path.join(root, NOTES_FILE), 'utf8');
  assert.match(written, /a note/);
});

test('readProjectNotes returns an empty string when there are no notes', async () => {
  const root = await scratch();

  assert.equal(await readProjectNotes(root), '');
});

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

test('runGit resolves to an empty string when the command fails', async () => {
  const root = await scratch();

  const output = await runGit(['log', '-5', '--oneline'], root);

  assert.equal(output, '');
});

test('collectGitContext never throws outside a repository', async () => {
  const root = await scratch();

  const context = await collectGitContext(root);

  assert.equal(typeof context.gitStatus, 'string');
  assert.equal(typeof context.gitLog, 'string');
});

test('collectGitContext reads status and log inside a repository', async (t) => {
  const root = await scratch();
  await write(root, 'README.md', '# hello');
  const { execFileSync } = require('node:child_process');

  try {
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: root, stdio: 'ignore' });
  } catch {
    t.skip('git is not available in this environment');
    return;
  }

  const context = await collectGitContext(root);

  assert.match(context.gitLog, /initial/);
});
