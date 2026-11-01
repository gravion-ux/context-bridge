# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |
| < 0.1 | No |

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/gravion-ux/gravion-context-bridge/security/advisories/new)
on this repository. If that is unavailable, open a regular issue that contains **no exploit
details and no private data**, and ask for a private channel.

Please do not include real credentials, tokens or customer data in a report. Redact them first.

You can expect an acknowledgement within a few days. Because this is an early MVP maintained by
one person, a full fix timeline is not guaranteed — please describe the impact clearly so it can
be prioritised.

## Data handling

Gravion Context Bridge is local-first by design:

- Handoffs are written to `<workspace>/.gravion/handoffs/` on your machine.
- Project notes are written to `<workspace>/.gravion/project-notes.md`.
- `.gravion/` is excluded by `.gitignore`, so handoffs and notes are not committed by accident.
- **No telemetry** is collected.
- **No AI provider is contacted.** The extension never sends code, prompts or handoffs to a
  model API.
- **No automatic upload or context sharing** happens. You decide whether and where to share a
  handoff, by copying it or pasting it yourself.
- Editor contents are only collected after you explicitly choose to include them.
- Git commands are read-only: `git status --short` and `git log -5 --oneline --decorate=no`.

## Secret redaction is best-effort

When redaction is enabled (the default), the extension replaces common credential patterns:

- Private key blocks (`-----BEGIN ... PRIVATE KEY-----`).
- GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`).
- AWS access key IDs (`AKIA` + 16 characters).
- Stripe-style keys (`sk_live_`, `sk_test_`, `rk_live_`, `pk_live_` and variants).
- OpenAI-style keys (`sk-...`), including `sk-ant-...`.
- Google API keys (`AIza...`).
- Slack tokens (`xoxb-`, `xoxp-`, `xoxa-`, `xoxr-`, `xoxs-`).
- GitLab tokens (`glpat-...`).
- JSON Web Tokens.
- The **whole value** of an `Authorization` field, whatever the scheme. Redacting only the scheme
  would leave `Basic dXNlcjpwYXNz` in clear text.
- Bearer tokens.
- Named assignments such as `API_KEY=...`, `"api_key": "..."`, `token: ...`, `password = ...`,
  `client_secret=...`.

**This is pattern matching, not a complete secret scanner.** Known limitations:

- Values that are unquoted and contain spaces are only partially redacted
  (`password: my secret phrase` redacts only the first word).
- Credentials with unusual formats, custom names or encodings (base64, encrypted blobs,
  environment-specific formats) are not detected.
- A credential that is split across lines, or that lives inside a file the redactor never sees, is
  not detected.
- The redaction runs on the generated text; it does not scan your project as a whole.
- Redaction can produce false positives on ordinary text that looks like a secret assignment.

**Always read a handoff before sharing it.** Treat every handoff as potentially containing
sensitive material.

## A handoff is a trust boundary

A handoff is read by the next agent, and the next agent acts on it. That makes the document a
place where content from your project — file names, commit messages, editor excerpts, your own
answers — can attempt to give instructions to whatever reads it next.

The renderer therefore treats every free-text value as untrusted input:

- Headings, blockquotes, thematic breaks, setext underlines, raw HTML and fence lines in a
  free-text answer are escaped, so they render as text instead of as structure.
- A value used inline is collapsed onto a single line, so it cannot open a new section.
- Editor excerpts and Git output are fenced with a fence computed from the content, so a backtick
  run inside the content cannot close the block early.

This reduces the ability of project content to forge handoff sections. It is not a complete
solution to prompt injection, and it does not change the fact that **you should read a handoff
before you paste it into another agent.**

## Files that are never read or listed

The workspace listing excludes `node_modules`, `.git`, `dist`, `build`, `coverage`, `.next` and
the extension's own `.gravion` directory. The match is case-insensitive, so `NODE_MODULES` is
excluded as well on a case-insensitive filesystem.

Files commonly used to store credentials — `.env`, `.env.*`, `id_rsa`, `id_dsa`, `id_ecdsa`,
`id_ed25519`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.jks`, `.npmrc`, `.netrc`,
`.pypirc`, `.htpasswd`, `.git-credentials`, `.dockercfg`, `credentials`, `credentials.*`,
`secrets`, `secrets.*`, `service-account.*` — are never listed and their contents are never
collected.

Symbolic links are never listed and never followed. A path that cannot be resolved to a location
inside the workspace is not collected. A directory that cannot be read is counted and reported in
the handoff rather than silently omitted.

This is a convenience filter, not a guarantee: a secret stored under an unusual filename can
still appear in a listing, and an editor excerpt can contain anything in that file.

## Known gaps in this release

- Secret redaction does not cover every credential format (see above).
- The escaping of free-text answers reduces structural injection, but it is not a complete
  defence against prompt injection. Review every handoff before handing it to another agent.
- Token estimation is approximate and not tied to any specific tokenizer.
- The VS Code UI has not yet been validated through a full manual smoke test.
- There is no defence against a compromised editor, extension or operating system.

The audit that produced the current behaviour, including the test evidence for each fix, is in
[docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md).
