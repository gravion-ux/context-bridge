'use strict';

const path = require('node:path');
const vscode = require('vscode');

const {
  DEFAULTS,
  generateHandoff,
  truncateText,
} = require('./core');

const {
  appendProjectNote,
  collectGitContext,
  collectWorkspaceEntries,
  isInsideWorkspace,
  latestHandoffPath,
  readProjectNotes,
  saveHandoff,
} = require('./workspace');

const CONFIG_SECTION = 'gravionContextBridge';

function configuration() {
  return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

function workspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  return folders[0].uri.fsPath;
}

function numericSetting(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function reportError(message) {
  vscode.window.showErrorMessage(`Gravion Context Bridge: ${message}`);
}

function reportInfo(message) {
  vscode.window.showInformationMessage(`Gravion Context Bridge: ${message}`);
}

/**
 * Reads the visible editor tabs that belong to this workspace. Contents are
 * truncated and later redacted by the core module.
 */
async function collectEditorExcerpts(root, maxChars) {
  const groups = (vscode.window.tabGroups && vscode.window.tabGroups.all) || [];
  const tabs = groups.flatMap((group) => group.tabs || []);
  const excerpts = [];

  for (const tab of tabs) {
    const input = tab.input;
    if (!input || !input.uri || input.viewType !== 'text') {
      continue;
    }
    if (!await isInsideWorkspace(root, input.uri.fsPath)) {
      continue;
    }

    let document;
    try {
      document = await vscode.workspace.openTextDocument(input.uri);
    } catch {
      continue;
    }

    const { text, truncated } = truncateText(document.getText(), maxChars);
    excerpts.push({
      path: path.relative(root, input.uri.fsPath).split(path.sep).join('/'),
      languageId: document.languageId || 'text',
      content: text,
      truncated,
    });
  }

  return excerpts;
}

async function promptForText(prompt, placeHolder) {
  return vscode.window.showInputBox({
    prompt,
    placeHolder,
    ignoreFocusOut: true,
  });
}

async function createSessionHandoff() {
  const root = workspaceRoot();
  if (!root) {
    reportError('open a project folder before creating a handoff.');
    return;
  }

  const title = await promptForText(
    'Gravion Context Bridge: task or project title',
    'Short and specific, for example "Fix flaky checkout test"'
  );
  if (title === undefined) {
    return;
  }

  const goal = await promptForText(
    'Gravion Context Bridge: goal',
    'What are you trying to achieve in this session?'
  );
  if (goal === undefined) {
    return;
  }

  const currentState = await promptForText(
    'Gravion Context Bridge: current state',
    'What works today, and what is broken?'
  );
  if (currentState === undefined) {
    return;
  }

  const decisions = await promptForText(
    'Gravion Context Bridge: decisions already made',
    'Choices the next agent should not silently reverse'
  );
  if (decisions === undefined) {
    return;
  }

  const nextSteps = await promptForText(
    'Gravion Context Bridge: next steps',
    'What should happen next?'
  );
  if (nextSteps === undefined) {
    return;
  }

  const blockers = await promptForText(
    'Gravion Context Bridge: open questions or blockers',
    'Anything unresolved, or leave empty'
  );
  if (blockers === undefined) {
    return;
  }

  const config = configuration();
  const maxDepth = numericSetting(
    config.get('workspaceListingMaxDepth'),
    DEFAULTS.workspaceListingMaxDepth
  );
  const maxEntries = numericSetting(
    config.get('workspaceListingMaxEntries'),
    DEFAULTS.workspaceListingMaxEntries
  );
  const maxChars = numericSetting(
    config.get('editorExcerptMaxChars'),
    DEFAULTS.editorExcerptMaxChars
  );
  const includeGitContext = config.get('includeGitContext') !== false;
  const redact = config.get('redactSecrets') !== false;

  const { entries, skipped } = await collectWorkspaceEntries(root, maxDepth, maxEntries);
  const gitContext = includeGitContext
    ? await collectGitContext(root)
    : { gitStatus: '', gitLog: '' };
  const projectNotes = await readProjectNotes(root);

  const editorChoice = await vscode.window.showQuickPick(
    ['Include visible editor contents', 'Do not include editor contents'],
    {
      placeHolder: 'Should this handoff include the contents of visible editor tabs?',
      ignoreFocusOut: true,
    }
  );
  if (editorChoice === undefined) {
    return;
  }

  const editorExcerpts = editorChoice === 'Include visible editor contents'
    ? await collectEditorExcerpts(root, maxChars)
    : [];

  const handoff = generateHandoff({
    title,
    goal,
    currentState,
    decisions,
    nextSteps,
    blockers,
    workspaceName: path.basename(root),
    workspaceEntries: entries,
    workspaceListingMaxEntries: maxEntries,
    workspaceListingSkipped: skipped,
    gitStatus: gitContext.gitStatus,
    gitLog: gitContext.gitLog,
    projectNotes,
    editorExcerpts,
    redactSecrets: redact,
  });

  const filePath = await saveHandoff(root, handoff.markdown);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  await vscode.window.showTextDocument(document);

  reportInfo(`handoff saved to ${path.relative(root, filePath)} (~${handoff.estimatedTokens} estimated tokens).`);
}

async function copyLatestHandoff() {
  const root = workspaceRoot();
  if (!root) {
    reportError('open a project folder first.');
    return;
  }

  const filePath = await latestHandoffPath(root);
  if (!filePath) {
    reportInfo('no handoff has been created in this project yet.');
    return;
  }

  const content = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath))
    .then((bytes) => Buffer.from(bytes).toString('utf8'));
  await vscode.env.clipboard.writeText(content);
  reportInfo('latest handoff copied to the clipboard.');
}

async function openLatestHandoff() {
  const root = workspaceRoot();
  if (!root) {
    reportError('open a project folder first.');
    return;
  }

  const filePath = await latestHandoffPath(root);
  if (!filePath) {
    reportInfo('no handoff has been created in this project yet.');
    return;
  }

  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  await vscode.window.showTextDocument(document);
}

async function addProjectNote() {
  const root = workspaceRoot();
  if (!root) {
    reportError('open a project folder first.');
    return;
  }

  const note = await promptForText(
    'Gravion Context Bridge: project note',
    'A durable decision, constraint or known issue'
  );
  if (note === undefined) {
    return;
  }
  if (!note.trim()) {
    reportInfo('no note recorded.');
    return;
  }

  await appendProjectNote(root, note);

  reportInfo('project note saved to .gravion/project-notes.md.');
}

function guard(handler) {
  return async () => {
    try {
      await handler();
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      reportError(`unexpected failure: ${message}`);
    }
  };
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'gravionContextBridge.createSessionHandoff',
      guard(createSessionHandoff)
    ),
    vscode.commands.registerCommand(
      'gravionContextBridge.copyLatestHandoff',
      guard(copyLatestHandoff)
    ),
    vscode.commands.registerCommand(
      'gravionContextBridge.openLatestHandoff',
      guard(openLatestHandoff)
    ),
    vscode.commands.registerCommand(
      'gravionContextBridge.addProjectNote',
      guard(addProjectNote)
    )
  );
}

function deactivate() {
  // Nothing to dispose: all state lives on disk inside the workspace.
}

module.exports = { activate, deactivate };
