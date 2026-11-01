# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Security and reliability fixes from the audit in [docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md).
Thirteen defects were confirmed against commit `8bd9b86` and fixed. The test suite grew from 12
to 66 tests; every defect proof fails against the pre-fix tree and passes against this one.

### Security

- Free-text answers to the handoff questions are escaped, so a pasted file or a commit message can
  no longer forge a section of the handoff. Headings, blockquotes, thematic breaks, raw HTML and
  fence lines are neutralised while the text stays readable.
- Editor excerpts and Git output are fenced with a fence computed from the content, so content
  that contains a backtick run can no longer close the block early and inject raw Markdown.
- An `Authorization` field now has its entire value redacted. Previously only the scheme was
  removed and the credential itself survived in clear text.
- The workspace listing is passed through the redactor, so a secret-shaped file name is no longer
  emitted verbatim.
- Redaction now also covers Google API keys, Slack tokens, GitLab tokens and JWTs.
- The credential file list was extended to `.npmrc`, `.netrc`, `.pypirc`, `.htpasswd`,
  `credentials.*`, `secrets.*`, `service-account.*` and `*.jks`.
- The directory and file skip lists are matched case-insensitively, so `NODE_MODULES` and `.ENV`
  are skipped as well.
- Workspace containment resolves symbolic links, so a link inside the workspace that points
  outside it is rejected. Symbolic links are never listed and never followed.

### Fixed

- Two handoffs created in the same second no longer overwrite each other. Filenames carry
  milliseconds and the file is created exclusively.
- The extension's own `.gravion/` directory is no longer listed in the workspace listing.
- A malformed `editorExcerpts` or `workspaceEntries` value no longer throws while rendering.
- Truncating an excerpt no longer splits a surrogate pair in half.

### Changed

- The filesystem and Git layer moved from `src/extension.js` into `src/workspace.js`, which has no
  VS Code dependency. `src/extension.js` is now thin glue. This is what makes the disk and Git
  behaviour testable without an Extension Development Host.
- The handoff filename now includes milliseconds: `handoff-20261028-094512-742.md`.
- `npm run check` now syntax-checks every source and test file, including `src/workspace.js`.

### Added

- `test/security-regressions.test.js` — 25 regression tests for the audited defects.
- `test/workspace.test.js` — 23 tests for the filesystem and Git layer.
- `test/extension.test.js` — 6 tests for the VS Code glue, with a stubbed `vscode` module.
- `docs/SECURITY_AUDIT.md` — the audit report, with the pre-fix and post-fix test evidence.

## [0.1.0] - 2026-10-27

Initial MVP.

### Added

- `Create Session Handoff` command that prompts for the task title, goal, current state,
  decisions, next steps and open questions.
- Structured Markdown handoff output with a "Continuation instructions for the next agent"
  section.
- Bounded workspace listing with a configurable depth and entry cap.
- Skipping of `node_modules`, `.git`, `dist`, `build`, `coverage` and `.next`.
- Skipping of `.env*` files, private key files and other credential-bearing filenames.
- Optional read-only Git context (`git status --short`, `git log -5 --oneline --decorate=no`).
- Optional editor excerpts for visible tabs, with per-file truncation.
- Best-effort secret redaction for API keys, GitHub tokens, AWS access key IDs, private key
  blocks, bearer tokens and named secret assignments.
- Approximate token estimation based on a four-character budget.
- `Add Project Note` command storing durable notes in `.gravion/project-notes.md`.
- `Copy Latest Handoff` and `Open Latest Handoff` commands.
- Project notes are included in generated handoffs.
- GitHub Actions CI running `npm test` and `npm run check` on Node.js 18, 20 and 22.

### Known limitations

- Secret redaction is best-effort pattern matching, not a complete secret scanner.
- Token estimation is approximate and not tied to any specific tokenizer.
- The VS Code UI has not yet been validated through a full manual smoke test.

[0.1.0]: https://github.com/gravion-ux/gravion-context-bridge/releases/tag/v0.1.0
