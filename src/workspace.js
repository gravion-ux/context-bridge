'use strict';

/**
 * Filesystem, Git and path helpers for Gravion Context Bridge.
 *
 * This module deliberately has no VS Code dependency: every function here is
 * plain Node, so the part of the extension that touches the disk, runs Git
 * and decides what belongs to the workspace can be tested headlessly.
 */

const path = require('node:path');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');

const { shouldSkipDirectory, isSecretFileName } = require('./core');

const HANDOFF_DIR = path.join('.gravion', 'handoffs');
const NOTES_FILE = path.join('.gravion', 'project-notes.md');
const HANDOFF_PREFIX = 'handoff-';

const HANDOFF_NAME = /^handoff-(\d{8})-(\d{6})(?:-(\d{3}))?(?:-(\d+))?\.md$/;

/**
 * A sortable, human-readable filename stamp. Milliseconds are included so two
 * handoffs created in quick succession do not collide.
 */
function timestampSlug(date) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    '-',
    pad(date.getMilliseconds(), 3),
  ].join('');
}

/**
 * Extracts the ordering key from a handoff filename. Returns undefined for
 * names that do not follow the convention.
 */
function parseHandoffName(name) {
  const match = HANDOFF_NAME.exec(name);
  if (!match) {
    return undefined;
  }
  const [, date, time, milliseconds, attempt] = match;
  return {
    stamp: `${date}${time}${milliseconds || '000'}`,
    attempt: attempt ? Number(attempt) : 0,
    name,
  };
}

/**
 * Collects a bounded, sorted listing of the workspace. Dependency and
 * generated directories are skipped, symbolic links are never followed, and
 * files that commonly hold credentials are never listed.
 *
 * Returns `{ entries, skipped }`, where `skipped` records directories that
 * could not be read, so the caller can report the gap instead of presenting a
 * truncated listing as complete.
 */
async function collectWorkspaceEntries(root, maxDepth, maxEntries) {
  const entries = [];
  const skipped = [];

  async function walk(directory, depth, relative) {
    if (depth > maxDepth || entries.length >= maxEntries) {
      return;
    }

    let items;
    try {
      items = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      skipped.push({ path: relative || '.', reason: error && error.code ? error.code : 'UNKNOWN' });
      return;
    }

    items.sort((left, right) => left.name.localeCompare(right.name));

    for (const item of items) {
      if (entries.length >= maxEntries) {
        return;
      }

      const relativePath = relative ? `${relative}/${item.name}` : item.name;

      if (item.isSymbolicLink()) {
        // A link can point anywhere, including outside the workspace.
        continue;
      }

      if (item.isDirectory()) {
        if (shouldSkipDirectory(item.name)) {
          continue;
        }
        entries.push({ path: relativePath, kind: 'directory' });
        await walk(path.join(directory, item.name), depth + 1, relativePath);
        continue;
      }

      if (!item.isFile() || isSecretFileName(item.name)) {
        continue;
      }

      entries.push({ path: relativePath, kind: 'file' });
    }
  }

  await walk(root, 0, '');
  return { entries, skipped };
}

/**
 * Runs a read-only Git command. Failures (not a repository, Git missing)
 * resolve to an empty string instead of throwing.
 */
function runGit(args, cwd) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve('');
          return;
        }
        resolve(String(stdout).trim());
      }
    );
  });
}

async function collectGitContext(root) {
  const [gitStatus, gitLog] = await Promise.all([
    runGit(['status', '--short'], root),
    runGit(['log', '-5', '--oneline', '--decorate=no'], root),
  ]);
  return { gitStatus, gitLog };
}

async function realpathOrUndefined(target) {
  try {
    return await fs.realpath(target);
  } catch {
    return undefined;
  }
}

/**
 * True when `filePath` belongs to the workspace.
 *
 * The lexical check alone is not enough: a symbolic link inside the workspace
 * can point at a file outside it, and that file must not be pulled into a
 * handoff. When a path cannot be resolved the lexical result is kept, so a
 * file that has not been written yet is still accepted.
 */
async function isInsideWorkspace(root, filePath) {
  const lexical = path.relative(root, filePath);
  if (lexical === '' || lexical.startsWith('..') || path.isAbsolute(lexical)) {
    return false;
  }

  const [realRoot, realFile] = await Promise.all([
    realpathOrUndefined(root),
    realpathOrUndefined(filePath),
  ]);

  if (!realRoot || !realFile) {
    return true;
  }

  const relative = path.relative(realRoot, realFile);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Writes a handoff without ever overwriting an existing one. The file is
 * created exclusively, and a counter is appended if the name is taken.
 */
async function saveHandoff(root, markdown, options = {}) {
  const directory = path.join(root, HANDOFF_DIR);
  await fs.mkdir(directory, { recursive: true });

  const now = options.now instanceof Date ? options.now : new Date();
  const base = `${HANDOFF_PREFIX}${timestampSlug(now)}`;

  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${attempt}`;
    const filePath = path.join(directory, `${base}${suffix}.md`);
    try {
      await fs.writeFile(filePath, markdown, { encoding: 'utf8', flag: 'wx' });
      return filePath;
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        continue;
      }
      throw error;
    }
  }

  throw new Error('could not find an unused handoff filename');
}

/**
 * Returns the path of the most recent handoff, or undefined when there is
 * none. Ordering follows the timestamp embedded in the filename, not the
 * order the filesystem happens to return.
 */
async function latestHandoffPath(root) {
  const directory = path.join(root, HANDOFF_DIR);
  let names;
  try {
    names = await fs.readdir(directory);
  } catch {
    return undefined;
  }

  const candidates = names
    .filter((name) => name.startsWith(HANDOFF_PREFIX) && name.endsWith('.md'))
    .map((name) => ({ name, parsed: parseHandoffName(name) }))
    .sort((left, right) => {
      if (left.parsed && right.parsed) {
        if (left.parsed.stamp !== right.parsed.stamp) {
          return left.parsed.stamp < right.parsed.stamp ? 1 : -1;
        }
        if (left.parsed.attempt !== right.parsed.attempt) {
          return left.parsed.attempt < right.parsed.attempt ? 1 : -1;
        }
        return left.name < right.name ? 1 : -1;
      }
      if (left.parsed) {
        return -1;
      }
      if (right.parsed) {
        return 1;
      }
      return left.name < right.name ? 1 : -1;
    });

  return candidates.length ? path.join(directory, candidates[0].name) : undefined;
}

async function readProjectNotes(root) {
  try {
    return await fs.readFile(path.join(root, NOTES_FILE), 'utf8');
  } catch {
    return '';
  }
}

async function appendProjectNote(root, note, options = {}) {
  const filePath = path.join(root, NOTES_FILE);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const existing = await readProjectNotes(root);
  const separator = existing && !existing.endsWith('\n') ? '\n' : '';
  const stamp = options.now instanceof Date ? options.now.toISOString() : new Date().toISOString();
  const entry = `${existing}${separator}\n## ${stamp}\n\n${String(note).trim()}\n`;
  await fs.writeFile(filePath, entry, 'utf8');
  return filePath;
}

module.exports = {
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
};
