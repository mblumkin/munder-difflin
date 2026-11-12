'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const source = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const { HIVE_TASK_STATUSES, normalizeHiveTaskStatus } = loadTs('src/shared/taskStatus.ts');

test('ready is a normalized first-class status while unknown values retain the Todo fallback', () => {
  assert.deepEqual(HIVE_TASK_STATUSES, ['todo', 'doing', 'ready', 'blocked', 'done', 'backlog', 'cancelled']);
  assert.equal(normalizeHiveTaskStatus('ready'), 'ready');
  assert.equal(normalizeHiveTaskStatus('backlog'), 'backlog');
  assert.equal(normalizeHiveTaskStatus('cancelled'), 'cancelled');
  assert.equal(normalizeHiveTaskStatus(null), 'todo');
});

function renderKanbanWithTasks(rawTasks) {
  const React = require('react');
  const ReactDOMServer = require('react-dom/server');
  const componentPath = path.join(root, 'src/renderer/src/components/TasksKanban.tsx');
  const state = [];
  let hookIndex = 0;
  const store = { agents: [], restorableAgents: [], openTaskDetail() {} };
  const originals = {
    useState: React.useState,
    useEffect: React.useEffect,
    useCallback: React.useCallback,
    useRef: React.useRef,
    load: Module._load,
    tsx: Module._extensions['.tsx']
  };

  React.useState = (initial) => {
    const index = hookIndex++;
    if (!(index in state)) state[index] = initial;
    return [state[index], (next) => {
      state[index] = typeof next === 'function' ? next(state[index]) : next;
    }];
  };
  React.useEffect = () => {};
  React.useCallback = (callback) => callback;
  React.useRef = (initial) => ({ current: initial });
  Module._extensions['.tsx'] = (mod, filename) => {
    const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true
      },
      fileName: filename
    });
    mod._compile(output.outputText, filename);
  };
  Module._load = function (request, parent, isMain) {
    if (parent?.filename === componentPath) {
      if (request === '@shared/taskStatus') return loadTs('src/shared/taskStatus.ts');
      if (request === '@/store/store') return { useStore: (selector) => selector(store) };
      if (request === 'react-i18next') return { useTranslation: () => ({ t: (key) => key }) };
      if (request === '@/markdown/MarkdownPreview') return { MarkdownPreview: () => null };
      if (request === '@/i18n/useDirection') return { useRtl: () => false };
      if (request === './PixelPanel') return { PixelPanel: () => null };
      if (request === './PixelButton') return { PixelButton: () => null };
      if (request === './PixelBadge') return { PixelBadge: () => null };
      if (request === './Icon') return { Icon: () => null };
    }
    return originals.load.call(this, request, parent, isMain);
  };

  try {
    const { TasksKanban, parseTasks } = require(componentPath);
    state[0] = parseTasks(rawTasks);
    const materialize = (node) => {
      if (Array.isArray(node)) return node.map(materialize);
      if (!React.isValidElement(node)) return node;
      if (typeof node.type === 'function') return materialize(node.type(node.props));
      return { type: node.type, props: node.props, children: materialize(node.props.children) };
    };
    hookIndex = 0;
    const collapsedElement = TasksKanban();
    const collapsed = materialize(collapsedElement);
    const collapsedMarkup = ReactDOMServer.renderToStaticMarkup(collapsedElement);
    const columns = collapsed.children[1].children;
    const lane = (status) => columns.find((column) => renderedText(column.children[0]).startsWith(`kanban.col${status}`));
    const todo = lane('Todo');
    const ready = lane('Ready');
    const backlog = lane('Backlog');
    const cancelled = lane('Cancelled');
    const toggle = backlog.children[0];
    toggle.props.onClick();
    hookIndex = 0;
    const expandedElement = TasksKanban();
    const expanded = materialize(expandedElement);
    const expandedMarkup = ReactDOMServer.renderToStaticMarkup(expandedElement);
    return {
      collapsed: { columns, todo, ready, backlog, cancelled, toggle, markup: collapsedMarkup },
      expanded: { backlog: laneFrom(expanded, 'Backlog'), markup: expandedMarkup }
    };
  } finally {
    React.useState = originals.useState;
    React.useEffect = originals.useEffect;
    React.useCallback = originals.useCallback;
    React.useRef = originals.useRef;
    Module._load = originals.load;
    if (originals.tsx) Module._extensions['.tsx'] = originals.tsx;
    else delete Module._extensions['.tsx'];
    delete require.cache[componentPath];
  }
}

function laneFrom(tree, status) {
  return tree.children[1].children.find((column) => renderedText(column.children[0]).startsWith(`kanban.col${status}`));
}

function renderedText(node) {
  if (Array.isArray(node)) return node.map(renderedText).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return node && typeof node === 'object' ? renderedText(node.children) : '';
}

test('TasksKanban renders Ready separately, filters Cancelled, and falls unknown statuses to Todo', () => {
  const tree = renderKanbanWithTasks({ tasks: [
    { id: 'AEON-READY', title: 'Ready card', status: 'ready' },
    { id: 'AEON-CANCELLED', title: 'Cancelled card', status: 'cancelled' },
    { id: 'AEON-BACKLOG', title: 'Backlog card', status: 'backlog' },
    { id: 'AEON-TODO', title: 'Todo card', status: 'todo' },
    { id: 'AEON-UNKNOWN', title: 'Unknown status card', status: 'mystery' }
  ] });
  const { todo, backlog, cancelled, toggle } = tree.collapsed;
  assert.match(renderedText(tree.collapsed.ready.children[0]), /kanban\.colReady/);
  assert.match(renderedText(tree.collapsed.ready.children[1]), /Ready card/);
  assert.doesNotMatch(renderedText(todo.children[1]), /Ready card/);
  assert.equal(cancelled, undefined, 'there is no Cancelled lane');
  assert.equal(toggle.type, 'button');
  assert.equal(toggle.props['aria-expanded'], false, 'Backlog starts collapsed');
  assert.match(renderedText(toggle), /1$/, 'the collapsed Backlog header shows its card count');
  assert.equal(backlog.children[1].props.hidden, true, 'the Backlog card container is hidden');
  assert.match(tree.collapsed.markup, /aria-expanded="false"/);
  assert.match(tree.collapsed.markup, /id="kanban-backlog-cards" hidden=""/);
  assert.match(renderedText(todo.children[1]), /Todo card/);
  assert.match(renderedText(todo.children[1]), /Unknown status card/, 'unknown status cards render in Todo');
  assert.doesNotMatch(tree.collapsed.markup, /Cancelled card/, 'cancelled cards are filtered from the board');

  const expandedBacklog = tree.expanded.backlog;
  assert.equal(expandedBacklog.children[0].props['aria-expanded'], true, 'the toggle expands Backlog');
  assert.equal(expandedBacklog.children[1].props.hidden, false);
  assert.match(renderedText(expandedBacklog.children[1]), /Backlog card/);
  assert.match(tree.expanded.markup, /aria-expanded="true"/);
  assert.match(tree.expanded.markup, /id="kanban-backlog-cards"/);
  assert.doesNotMatch(tree.expanded.markup, /id="kanban-backlog-cards" hidden=""/);
  assert.match(tree.expanded.markup, /Backlog card/);
});

test('the board reads Backlog, To Do, Doing, Blocked, Ready, Done, and no two lanes share an accent', () => {
  const { columns } = renderKanbanWithTasks({ tasks: [{ id: 'AEON-BACKLOG', title: 'Backlog card', status: 'backlog' }] }).collapsed;
  const lanes = columns.map((column) => ({
    label: renderedText(column.children[0]).match(/^kanban\.col([A-Za-z]+)/)[1],
    accent: column.children[0].props.style.background
  }));
  assert.deepEqual(lanes.map((l) => l.label), ['Backlog', 'Todo', 'Doing', 'Blocked', 'Ready', 'Done']);
  assert.equal(new Set(lanes.map((l) => l.accent)).size, lanes.length, JSON.stringify(lanes));

  const notes = source('src/renderer/src/scene/office/themeRegistry.ts').match(/noteColors:\s*\{([^}]*)\}/)[1];
  const noteColors = Object.fromEntries([...notes.matchAll(/(\w+):\s*(0x[0-9a-f]+)/gi)].map(([, k, v]) => [k, v.toLowerCase()]));
  assert.ok(noteColors.ready, 'the floor has a note color for ready');
  assert.equal(new Set(Object.values(noteColors)).size, Object.keys(noteColors).length, JSON.stringify(noteColors));
});

test('task schemas and generated protocol consume the shared status list', () => {
  for (const file of [
    'src/main/hive.ts',
    'src/preload/index.ts',
    'src/main/realtimeActions.ts',
    'src/renderer/src/components/TasksKanban.tsx',
    'src/renderer/src/realtime/actions.ts',
    'src/renderer/src/realtime/tools.ts'
  ]) {
    assert.match(source(file), /taskStatus/, `${file} must use the shared task status definition`);
  }
  const guardrails = source('src/main/hive.ts').match(/const guardrailsLine = '([^']*)'/)?.[1];
  assert.match(guardrails || '', /todo\/doing\/ready\/blocked\/done\/backlog/);
  assert.match(source('src/renderer/src/realtime/tools.ts'), /ready.*in progress/s);
  assert.match(source('src/renderer/src/realtime/tools.ts'), /by\('ready'\)/);
  assert.match(source('src/renderer/src/realtime/tools.ts'), /\$\{ready\.length\} ready/);
  for (const locale of ['en', 'ar', 'zh-CN']) {
    assert.match(source(`src/renderer/src/i18n/locales/${locale}.json`), /"colReady"/);
  }
});

test('realtime schema recognizes Cancelled while summaries count Ready only', async () => {
  const originalLoad = Module._load;
  const originalWindow = global.window;
  global.window = { cth: {
    hiveAgentDirectory: async () => ({ agents: [] }),
    hiveTasks: async () => ({ tasks: [
      { id: 'AEON-DOING', title: 'Building', status: 'doing' },
      { id: 'AEON-READY', title: 'Signed off', status: 'ready' },
      { id: 'AEON-CANCELLED', title: 'Closed', status: 'cancelled' }
    ] })
  } };
  Module._load = function (request, parent, isMain) {
    if (request === '@openai/agents-realtime') return { tool: (definition) => definition };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const { realtimeReadTools, realtimeSessionSummary } = loadTs('src/renderer/src/realtime/tools.ts');
    const getTasks = realtimeReadTools().find((entry) => entry.name === 'get_tasks');
    assert.ok(getTasks);
    assert.deepEqual(getTasks.parameters.properties.status.enum, HIVE_TASK_STATUSES);
    assert.ok(getTasks.parameters.properties.status.enum.includes('cancelled'));
    const toolSummary = await getTasks.execute({});
    assert.match(toolSummary, /1 in progress, 1 ready/);
    assert.doesNotMatch(toolSummary, /cancelled/);
    const sessionSummary = await realtimeSessionSummary();
    assert.match(sessionSummary, /1 in progress, 1 ready, 0 blocked/);
    assert.doesNotMatch(sessionSummary, /cancelled/);
  } finally {
    Module._load = originalLoad;
    if (originalWindow === undefined) delete global.window;
    else global.window = originalWindow;
  }
});
