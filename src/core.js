'use strict';

const DEFAULTS = Object.freeze({
  redactSecrets: true,
  workspaceListingMaxEntries: 200,
  workspaceListingMaxDepth: 4,
  editorExcerptMaxChars: 4000,
});

/**
 * Directories that are never listed in a handoff. They are generated,
 * vendored or otherwise noisy and add no useful context.
 *
 * Matching is case-insensitive: on Windows and macOS the filesystem is
 * case-insensitive too, so `NODE_MODULES` is the same directory as
 * `node_modules` and must be skipped as well.
 */
const SKIP_DIRECTORIES = Object.freeze([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.gravion',
]);

function asText(value) {
  return value == null ? '' : String(value).replace(/\r\n/g, '\n');
}

function cleanSection(value, fallback = '_Not provided._') {
  const text = asText(value).trim();
  return text || fallback;
}

/**
 * Collapses a value to a single line so it cannot introduce a new Markdown
 * block when it is interpolated into an existing line. Every whitespace run
 * becomes one space, so a blank line cannot leave a double gap behind.
 */
function escapeInlineText(value) {
  return asText(value).replace(/\s+/g, ' ').trim();
}

/**
 * Neutralises Markdown structures that could forge a section of the handoff.
 *
 * Free-text answers are read by the next agent, so a file, a commit message
 * or a pasted note that contains a line such as `## Decisions already made`
 * must not be able to pose as a section of the handoff itself. Line breaks
 * are preserved so the answer stays readable; only the structural markers
 * are escaped.
 */
function escapeMarkdownText(value) {
  return asText(value)
    .split('\n')
    .map((line) => {
      if (/^\s{0,3}#{1,6}(\s|$)/.test(line)) {
        return `\\${line}`;
      }
      if (/^\s{0,3}>/.test(line)) {
        return `\\${line}`;
      }
      if (/^\s{0,3}<[A-Za-z!/?]/.test(line)) {
        return `\\${line}`;
      }
      if (/^\s{0,3}([-*_=]\s*){3,}$/.test(line)) {
        return `\\${line}`;
      }
      if (/^\s{0,3}(?:`{3,}|~{3,})/.test(line)) {
        return `\\${line}`;
      }
      return line;
    })
    .join('\n');
}

/**
 * Returns a code fence that is guaranteed to be longer than any backtick run
 * inside `content`, as required by CommonMark. Without this, content that
 * contains a fence closes the block early and the remainder is rendered as
 * document structure.
 */
function fenceFor(content) {
  const text = asText(content);
  const runs = text.match(/`+/g);
  let longest = 0;
  if (runs) {
    for (const run of runs) {
      if (run.length > longest) {
        longest = run.length;
      }
    }
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * True when a directory should be excluded from the workspace listing.
 */
function shouldSkipDirectory(name) {
  const normalized = asText(name).trim().toLowerCase();
  return SKIP_DIRECTORIES.includes(normalized);
}

/**
 * True for filenames that commonly hold credentials. These are never
 * listed and their contents are never collected.
 */
function isSecretFileName(name) {
  const fileName = asText(name).trim();
  if (!fileName) {
    return false;
  }
  const lower = fileName.toLowerCase();

  if (lower === '.env' || lower.startsWith('.env.')) {
    return true;
  }
  if (/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$/.test(lower)) {
    return true;
  }
  if (/\.(?:pem|key|p12|pfx|keystore|jks)$/.test(lower)) {
    return true;
  }
  if (/^\.?(?:npmrc|netrc|pypirc|htpasswd|git-credentials|dockercfg)$/.test(lower)) {
    return true;
  }
  if (/^(?:credentials|secrets?|service[-_]?account)(?:\.(?:json|ya?ml|toml|ini|conf|env|txt))?$/i.test(fileName)) {
    return true;
  }
  return false;
}

/**
 * Truncates text to a maximum character count and reports whether the
 * content was cut, so callers can label the excerpt honestly.
 */
function truncateText(value, maxChars) {
  const text = asText(value);
  const limit = Number.isFinite(maxChars) && maxChars > 0
    ? Math.floor(maxChars)
    : DEFAULTS.editorExcerptMaxChars;

  if (text.length <= limit) {
    return { text, truncated: false };
  }

  let slice = text.slice(0, limit);
  const last = slice.charCodeAt(slice.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    // Never split a surrogate pair: a lone surrogate is written as U+FFFD.
    slice = slice.slice(0, -1);
  }
  return { text: slice, truncated: true };
}

/**
 * Redacts a deliberately narrow set of common credential formats. This is a
 * convenience layer, not a substitute for reviewing content before sharing.
 */
function redactSecrets(value) {
  let text = asText(value);

  text = text.replace(
    /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/gi,
    '[REDACTED PRIVATE KEY]'
  );
  text = text.replace(
    /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    '[REDACTED GITHUB TOKEN]'
  );
  text = text.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED AWS ACCESS KEY]');
  text = text.replace(/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, '[REDACTED API KEY]');
  text = text.replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, '[REDACTED API KEY]');
  // Google API keys are `AIza` + 35 characters. The tail length is treated as
  // a lower bound so a key that was truncated in a log or a transcript is
  // still redacted instead of leaking its remaining characters.
  text = text.replace(/\bAIza[0-9A-Za-z_-]{30,}/g, '[REDACTED GOOGLE API KEY]');
  text = text.replace(/\b(?:xox[baprs]-)[0-9A-Za-z-]{10,}\b/g, '[REDACTED SLACK TOKEN]');
  text = text.replace(/\bglpat-[0-9A-Za-z_-]{20,}\b/g, '[REDACTED GITLAB TOKEN]');
  text = text.replace(
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    '[REDACTED JWT]'
  );

  // An Authorization field carries a scheme *and* a credential. Redacting the
  // scheme alone would leave `Basic <base64>` in clear text, so the whole
  // value of the field is replaced.
  text = text.replace(
    /(\b(?:proxy-)?authorization["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\r\n]*)/gi,
    (match, prefix, rawValue) => {
      const quote = rawValue.startsWith('"') ? '"' : rawValue.startsWith("'") ? "'" : '';
      return `${prefix}${quote}[REDACTED]${quote}`;
    }
  );

  // Named assignments such as API_KEY=..., "api_key": "..." or token: ...
  // The name may start with the keyword itself, so the keyword is allowed to
  // begin at the first character of the name.
  text = text.replace(
    /([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|passphrase|credential|authorization)[A-Za-z0-9_.-]*)(\s*["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|Bearer\s+[A-Za-z0-9._~+/=-]{8,}|[^\s"'`]+)/gi,
    (match, name, separator, rawValue) => {
      const quote = rawValue.startsWith('"') ? '"' : rawValue.startsWith("'") ? "'" : '';
      return `${name}${separator}${quote}[REDACTED]${quote}`;
    }
  );

  // Bare Authorization headers that are not attached to a named field.
  text = text.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]');

  return text;
}

function estimateTokens(value) {
  const length = asText(value).length;
  return length === 0 ? 0 : Math.ceil(length / 4);
}

function formatWorkspaceListing(entries, options = {}) {
  const maxEntries = Number.isFinite(options.maxEntries)
    ? Math.max(0, Math.floor(options.maxEntries))
    : DEFAULTS.workspaceListingMaxEntries;
  const safeEntries = Array.isArray(entries) ? entries.slice(0, maxEntries) : [];
  const lines = safeEntries.map((entry) => {
    if (typeof entry === 'string') {
      return `- ${entry}`;
    }
    const suffix = entry && entry.kind === 'directory' ? '/' : '';
    return `- ${asText(entry && entry.path)}${suffix}`;
  });
  if (Array.isArray(entries) && entries.length > safeEntries.length) {
    lines.push(`- _Listing capped at ${maxEntries} entries._`);
  }
  return lines.length ? lines.join('\n') : '_No workspace entries collected._';
}

function formatEditorExcerpts(excerpts) {
  if (!Array.isArray(excerpts) || excerpts.length === 0) {
    return '_No editor excerpts included._';
  }
  return excerpts.map((excerpt) => {
    const language = asText(excerpt.languageId).trim() || 'text';
    const body = cleanSection(excerpt.content, '_Empty editor._');
    const fence = fenceFor(body);
    const truncated = excerpt.truncated ? '\n\n_Excerpt truncated._' : '';
    const heading = escapeInlineText(excerpt.path) || 'unknown';
    return `### ${heading}\n\n${fence}${language}\n${body}\n${fence}${truncated}`;
  }).join('\n\n');
}

function generateHandoff(input = {}) {
  const redact = input.redactSecrets !== false;
  const maybeRedact = (value) => redact ? redactSecrets(value) : asText(value);
  const section = (value, fallback) => cleanSection(escapeMarkdownText(maybeRedact(value)), fallback);

  const title = escapeInlineText(maybeRedact(input.title)) || 'Untitled session handoff';
  const workspaceName = escapeInlineText(maybeRedact(input.workspaceName)) || '_No workspace folder open._';
  const generatedAt = escapeInlineText(input.generatedAt || new Date().toISOString());

  const workspaceEntries = Array.isArray(input.workspaceEntries)
    ? input.workspaceEntries.map((entry) => {
      if (typeof entry === 'string') {
        return maybeRedact(entry);
      }
      if (!entry || typeof entry !== 'object') {
        return entry;
      }
      return { ...entry, path: maybeRedact(entry.path) };
    })
    : [];
  const workspaceListing = formatWorkspaceListing(workspaceEntries, {
    maxEntries: input.workspaceListingMaxEntries,
  });

  const skipped = Array.isArray(input.workspaceListingSkipped) ? input.workspaceListingSkipped : [];
  const listingNote = skipped.length
    ? `_${skipped.length} path(s) could not be listed (${escapeInlineText(
      skipped.map((item) => item && item.path).filter(Boolean).join(', ')
    )})._`
    : '';

  const gitStatus = cleanSection(escapeMarkdownText(maybeRedact(input.gitStatus)), '_Git context was not collected._');
  const gitLog = cleanSection(escapeMarkdownText(maybeRedact(input.gitLog)), '_Git context was not collected._');
  const projectNotes = section(input.projectNotes, '_No project notes recorded._');

  const rawExcerpts = Array.isArray(input.editorExcerpts) ? input.editorExcerpts : [];
  const excerpts = rawExcerpts
    .filter((excerpt) => excerpt && typeof excerpt === 'object')
    .map((excerpt) => ({
      ...excerpt,
      path: maybeRedact(excerpt.path),
      content: maybeRedact(excerpt.content),
    }));

  const gitStatusFence = fenceFor(gitStatus);
  const gitLogFence = fenceFor(gitLog);

  const body = `# Session Handoff: ${title}

> Generated locally by Gravion Context Bridge on ${generatedAt}. Review this handoff before sharing it: secret redaction is best-effort, not a guarantee.

## Project

- **Workspace:** ${workspaceName}
- **Task or project title:** ${title}

## Goal

${section(input.goal)}

## Current state

${section(input.currentState)}

## Decisions already made

${section(input.decisions)}

## Next steps

${section(input.nextSteps)}

## Open questions or blockers

${section(input.blockers)}

## Project notes

${projectNotes}

## Workspace listing

${workspaceListing}${listingNote ? `\n\n${listingNote}` : ''}

## Git status (read-only)

${gitStatusFence}text
${gitStatus}
${gitStatusFence}

## Recent commits (read-only)

${gitLogFence}text
${gitLog}
${gitLogFence}

## Optional visible-editor excerpts

${formatEditorExcerpts(excerpts)}

## Continuation instructions for the next agent

1. Verify the actual workspace files and current Git state before relying on this handoff.
2. Respect the recorded decisions unless new evidence contradicts them.
3. Ask before destructive or externally visible actions.
4. State which tests you actually ran and what remains unverified.
`;

  return {
    markdown: body,
    estimatedTokens: estimateTokens(body),
  };
}

module.exports = {
  DEFAULTS,
  SKIP_DIRECTORIES,
  estimateTokens,
  escapeInlineText,
  escapeMarkdownText,
  fenceFor,
  formatEditorExcerpts,
  formatWorkspaceListing,
  generateHandoff,
  isSecretFileName,
  redactSecrets,
  shouldSkipDirectory,
  truncateText,
};
