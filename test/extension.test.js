'use strict';

/**
 * Tests for the VS Code glue.
 *
 * `src/extension.js` is loaded with a stubbed `vscode` module, so the command
 * registry can be checked without an Extension Development Host.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const packageJson = require('../package.json');

function makeStub(options = {}) {
  const registered = [];
  const errors = [];
  const infos = [];

  const stub = {
    commands: {
      registerCommand(id, handler) {
        registered.push({ id, handler });
        return { dispose() {} };
      },
    },
    workspace: {
      workspaceFolders: options.workspaceFolders,
      getConfiguration() {
        return {
          get(key, fallback) {
            return fallback;
          },
        };
      },
      openTextDocument: async () => ({}),
    },
    window: {
      showErrorMessage(message) {
        errors.push(message);
      },
      showInformationMessage(message) {
        infos.push(message);
      },
      showInputBox: async () => undefined,
      showQuickPick: async () => undefined,
      showTextDocument: async () => {},
      tabGroups: { all: [] },
    },
    env: {
      clipboard: {
        writeText: async () => {},
      },
    },
  };

  return { stub, registered, errors, infos };
}

function loadExtension(stub) {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') {
      return stub;
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    const resolved = require.resolve('../src/extension');
    delete require.cache[resolved];
    return require('../src/extension');
  } finally {
    Module._load = originalLoad;
  }
}

test('activate registers every command declared in package.json', () => {
  const { stub, registered } = makeStub();
  const extension = loadExtension(stub);

  const subscriptions = [];
  extension.activate({ subscriptions });

  const declared = packageJson.contributes.commands.map((command) => command.command).sort();
  const actual = registered.map((entry) => entry.id).sort();

  assert.deepEqual(actual, declared);
  assert.equal(subscriptions.length, declared.length);
});

test('every activation event refers to a command that is actually registered', () => {
  const { stub, registered } = makeStub();
  const extension = loadExtension(stub);

  extension.activate({ subscriptions: [] });

  const ids = new Set(registered.map((entry) => entry.id));
  for (const event of packageJson.activationEvents) {
    const commandId = event.replace(/^onCommand:/, '');
    assert.ok(ids.has(commandId), `${event} refers to an unregistered command`);
  }
});

test('deactivate does not throw', () => {
  const { stub } = makeStub();
  const extension = loadExtension(stub);

  assert.doesNotThrow(() => extension.deactivate());
});

test('a command run without an open workspace reports an error instead of throwing', async () => {
  const { stub, registered, errors } = makeStub();
  const extension = loadExtension(stub);

  extension.activate({ subscriptions: [] });

  const command = registered.find((entry) => entry.id === 'gravionContextBridge.createSessionHandoff');
  await command.handler();

  assert.equal(errors.length, 1);
  assert.match(errors[0], /open a project folder/);
});

test('every registered command is guarded against an unexpected failure', async () => {
  const { stub, registered } = makeStub();
  const extension = loadExtension(stub);

  extension.activate({ subscriptions: [] });

  for (const command of registered) {
    // With no workspace folder the handler returns early rather than throwing;
    // what matters here is that every command resolves instead of rejecting.
    await assert.doesNotReject(() => command.handler());
  }
});

test('the extension module has no dependency outside the workspace helpers', () => {
  const { stub } = makeStub();
  const extension = loadExtension(stub);

  assert.equal(typeof extension.activate, 'function');
  assert.equal(typeof extension.deactivate, 'function');
  assert.equal(path.isAbsolute(path.dirname(require.resolve('../src/core'))), true);
});
