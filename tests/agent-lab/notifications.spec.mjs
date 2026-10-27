import { test, expect } from '@playwright/test';

// Synthetic contract scenarios; these do not reproduce production data.
test('notification history, status dot, mixed review counts and keyboard', async ({ page }) => {
  const data = { packages: [{ id: 'p', title: 'Notification fixture', state: 'review' }], articles: [], runs: [], discovery: [], channels: ['done', 'rejected', 'recheck'].map((status, i) => ({ id: `c${i}`, package_id: 'p', channel: ['threads', 'facebook', 'linkedin'][i], status, content: {} })) };
  let fail = true;
  await page.route('**/api/eb-v2/workspace', route => fail ? route.fulfill({ status: 500, json: { error: 'Synthetic connection failure' } }) : route.fulfill({ json: data }));
  await page.goto('/?screen=eb');
  const retry = page.getByRole('button', { name: 'Retry V2 connection', exact: true });
  await expect(retry).toBeVisible();
  await expect(retry).not.toContainText('V2 error');
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Notification center' });
  await panel.getByRole('tab', { name: 'Trạng thái hệ thống' }).click();
  await expect(panel.getByText('Synthetic connection failure', { exact: true })).toHaveCount(1);
  fail = false;
  await panel.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(panel).toBeFocused();
  await expect(panel.getByRole('tab', { name: 'Trạng thái hệ thống' })).toHaveAttribute('aria-selected', 'true');
  await panel.getByRole('tab', { name: 'Trạng thái hệ thống' }).focus();
  await page.keyboard.press('ArrowLeft');
  for (const message of ['1 channel output(s) await review', '1 channel output(s) completed', '1 channel output(s) rejected']) await expect(panel.getByText(message, { exact: true })).toBeVisible();
  await expect(panel.getByRole('tab', { name: 'Thông báo', exact: true })).toBeFocused();
  await panel.getByRole('button', { name: 'Close notifications', exact: true }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(panel.getByRole('button').last()).toBeFocused();
  await page.evaluate(async () => {
    const { notifyWorkspace } = await import('/src/components/workspace/WorkspaceNotification.tsx');
    notifyWorkspace('First event', 'success');
    notifyWorkspace('Second event', 'warning');
  });
  await expect(panel.getByText('First event', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeFocused();
  await page.waitForTimeout(4100);
  await page.keyboard.press('Enter');
  await expect(panel.getByText('First event', { exact: true })).toHaveCount(1);
  await expect(panel.getByText('Second event', { exact: true })).toHaveCount(1);
  const pending = panel.getByRole('button', { name: /1 channel output\(s\) await review/ });
  await pending.focus();
  await page.keyboard.press('Space');
  const details = panel.getByRole('region', { name: 'Notification details' });
  await expect(details.getByRole('heading', { name: 'Notification fixture', exact: true })).toBeVisible();
  await expect(details.getByText('Review · Gate 3 · LinkedIn · Recheck · awaiting review', { exact: true })).toBeVisible();
  await expect(details.getByRole('button', { name: '← Back to notifications' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(pending).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.workspace-notification')).toHaveCount(0);
});

test('NOTIFICATIONS_OFFLINE session store and all-output review contract', async () => {
  const { readFile } = await import('node:fs/promises');
  const { strict: assert } = await import('node:assert');
  const ts = (await import('typescript')).default;
  const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const source = await readFile('src/components/workspace/WorkspaceNotification.tsx', 'utf8');
  const module = { exports: {} };
  let changed = 0, unsubscribe;
  const react = { useSyncExternalStore(subscribe, snapshot) { unsubscribe = subscribe(() => changed++); return snapshot(); } };
  const events = [];
  new Function('require', 'exports', 'window', 'CustomEvent', compile(source))(() => react, module.exports, { dispatchEvent: event => events.push(event) }, class { constructor(type, options) { this.type = type; this.detail = options.detail; } });
  const { notifyWorkspace, useWorkspaceNotices } = module.exports;
  assert.equal(useWorkspaceNotices().length, 0);
  notifyWorkspace('First', 'success'); notifyWorkspace('Second', 'error'); notifyWorkspace('  ');
  assert.equal(changed, 2);
  unsubscribe();
  notifyWorkspace('While unmounted');
  const history = useWorkspaceNotices();
  assert.deepEqual(history.map(n => n.message), ['First', 'Second', 'While unmounted']);
  assert.equal(new Set(history.map(n => n.id)).size, 3);
  assert.equal(events.length, 3);
  unsubscribe();
  const workspace = await readFile('src/components/EbWorkingSpace.tsx', 'utf8');
  const summary = new Function(`${compile(workspace.slice(workspace.indexOf('function reviewSummary'), workspace.indexOf('function isEmergingDiscovery')))};return reviewSummary`)();
  assert.deepEqual(summary([{decision:'done'}, {decision:'reject'}, {decision:'recheck'}, {decision:null}]), {done:1,rejected:1,pending:2,label:'Rejected'});
  assert.ok(workspace.includes('reviewSummary(tasks.flatMap'));
  assert.ok(!source.includes('setTimeout'));
});

test('NOTIFICATIONS_OFFLINE details use live tasks, all channels and saved Discovery context', async () => {
  const { readFile } = await import('node:fs/promises');
  const { strict: assert } = await import('node:assert');
  const ts = (await import('typescript')).default;
  const workspace = await readFile('src/components/EbWorkingSpace.tsx', 'utf8');
  const code = workspace.slice(workspace.indexOf('function notificationDetails'), workspace.indexOf('function isEmergingDiscovery'));
  const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const details = new Function('gateConfig', 'discoveryTag', `${compiled};return notificationDetails`)({ article: { title: 'Article · Gate 2' }, adapt: { title: 'Adapt' } }, idea => idea.status);
  const task = { id: 'p', title: 'Saved title', gate: 'review', channels: [{ id: 'a', channel: 'Threads', decision: 'done' }, { id: 'b', channel: 'Facebook', decision: 'reject' }, { id: 'c', channel: 'LinkedIn', decision: 'recheck' }] };
  assert.match(details('review', [task], [])[0].context, /LinkedIn · Recheck/);
  assert.match(details('done', [task], [])[0].context, /Threads · Done/);
  assert.match(details('rejected', [task], [])[0].context, /Facebook · Rejected/);
  task.title = 'Updated title';
  task.channels[2].decision = 'done';
  assert.deepEqual(details('review', [task], []), []);
  assert.equal(details('done', [task], [])[1].title, 'Updated title');
  assert.deepEqual(details('done', [], []), []);
  assert.deepEqual(details('discovery', [], [{ id: 'd', title: 'Saved lead', status: 'Source lead', source_summary: 'Full saved summary' }]), [{ id: 'd', title: 'Saved lead', context: 'Source lead', body: 'Full saved summary' }]);
  assert.match(details('article', [{ id: 'p', title: 'Writing', gate: 'article', status: 'drafting' }], [])[0].context, /Gate 2 · Generating article/);
  assert.deepEqual(details('event-1', [], []), []);
});


test('NOTIFICATIONS_OFFLINE system counts and loading-error-recovery rendering contract', async () => {
  const { readFile } = await import('node:fs/promises');
  const { strict: assert } = await import('node:assert');
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const ts = (await import('typescript')).default;
  const source = await readFile('src/components/EbWorkingSpace.tsx', 'utf8');
  const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText;
  const review = new Function(`${compile(source.slice(source.indexOf('function reviewSummary'), source.indexOf('function isEmergingDiscovery')))};return reviewSummary`)();
  const countsFor = new Function('reviewSummary', `${compile(source.slice(source.indexOf('function workspaceStatusCounts'), source.indexOf('function NotificationPanel')))};return workspaceStatusCounts`)(review);
  const tasks = [{gate:'brief'}, {gate:'article'}, {gate:'adapt'}, {gate:'review', channels:[{decision:'done'}, {decision:'reject'}, {decision:'recheck'}]}];
  const counts = countsFor(tasks, 4);
  assert.deepEqual(counts.map(item => item.count), [1,1,1,1,1,1,4]);
  const Panel = new Function('React', 'useState', 'useRef', 'useEffect', 'X', `${compile(source.slice(source.indexOf('function NotificationPanel'), source.indexOf('function GateGroup')))};return NotificationPanel`)(React, initial => [initial === 'notices' ? 'system' : initial, () => {}], initial => ({current:initial}), () => {}, () => null);
  const render = (syncing, runtimeError, currentCounts) => renderToStaticMarkup(React.createElement(Panel, {notices:[], syncing, runtimeError, counts:currentCounts, onRetry(){}, onClose(){}}));
  const live = render(false, null, counts);
  assert.match(live, /V2 workspace is live/);
  assert.match(live, /workspace connection only/);
  assert.match(live, /aria-selected="true"[^>]*tabindex="0"/);
  const loading = render(true, null, counts);
  assert.match(loading, /counts are unconfirmed/);
  assert.match(loading, /disabled=""/);
  const failed = render(false, 'Synthetic failure', countsFor([], 4));
  assert.match(failed, /Synthetic failure/);
  assert.match(failed, /aria-label="Retry"/);
  assert.equal((failed.match(/<dd[^>]*>—<\/dd>/g) || []).length, 7);
  const recovered = render(false, null, countsFor([...tasks, {gate:'brief'}], 5));
  assert.match(recovered, />2<\/dd>/);
  assert.match(recovered, />5<\/dd>/);
  assert.doesNotMatch(recovered, /unconfirmed/);
  assert.ok(!source.includes('{ id: "connection"'));
});


test('NOTIFICATIONS_OFFLINE system totals use the complete workspace despite board filters', async () => {
  const { readFile } = await import('node:fs/promises');
  const { strict: assert } = await import('node:assert');
  const ts = (await import('typescript')).default;
  const source = await readFile('src/components/EbWorkingSpace.tsx', 'utf8');
  const ast = ts.createSourceFile('EbWorkingSpace.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions = new Map();
  let countsExpression;
  const visit = node => {
    if (ts.isFunctionDeclaration(node)) functions.set(node.name?.text, node.getText(ast));
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'NotificationPanel') {
      const counts = node.attributes.properties.find(prop => ts.isJsxAttribute(prop) && prop.name.getText(ast) === 'counts');
      countsExpression = counts?.initializer?.expression?.getText(ast);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(countsExpression, 'The real panel must receive workspace totals');
  const compiled = ts.transpileModule(
    `${functions.get('reviewSummary')}\n${functions.get('workspaceStatusCounts')}`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText;
  const panelCounts = new Function('tasks', 'filteredTasks', 'discoveryIdeas', `${compiled}; return (${countsExpression});`);
  const tasks = [
    { gate: 'brief' }, { gate: 'brief' }, { gate: 'article' }, { gate: 'adapt' },
    { gate: 'review', channels: [{ channel: 'Threads', decision: 'done' }, { channel: 'Facebook', decision: 'reject' }, { channel: 'LinkedIn', decision: 'recheck' }, { channel: 'Threads', decision: null }] },
  ];
  const discovery = [{ id: 'saved-1' }, { id: 'saved-2' }, { id: 'saved-3' }];
  const expected = [2, 1, 1, 2, 1, 1, 3];
  // Synthetic filtered views deliberately omit gates and review channels.
  for (const filtered of [[], tasks.slice(0, 1), [{ ...tasks[4], channels: tasks[4].channels.slice(0, 1) }]]) {
    assert.deepEqual(panelCounts(tasks, filtered, discovery).map(item => item.count), expected);
  }
  const refreshed = tasks.map(task => task.gate === 'review' ? { ...task, channels: task.channels.map(channel => ({ ...channel, decision: 'done' })) } : task);
  assert.deepEqual(panelCounts(refreshed, [], []).map(item => item.count), [2, 1, 1, 0, 4, 0, 0]);
  assert.deepEqual(panelCounts(tasks, [], discovery).map(item => item.count), expected, 'Refresh must not mutate the prior snapshot');
});

test('system tab persists through refresh failure and recovery without connection badge', async ({ page }) => {
  let fail = false;
  let release;
  let hold = false;
  await page.route('**/api/eb-v2/workspace', async route => {
    if (hold) await new Promise(resolve => { release = resolve; });
    await route.fulfill(fail ? {status:500, json:{error:'Synthetic refresh failure'}} : {json:{packages:[], articles:[], runs:[], discovery:[]}});
  });
  await page.goto('/?screen=eb');
  await expect(page.getByRole('button', {name:'Refresh V2 workspace', exact:true})).toBeEnabled();
  const bell = page.getByRole('button', {name:'Notifications', exact:true});
  await expect(bell).toHaveText('');
  await bell.click();
  const panel = page.getByRole('dialog', {name:'Notification center'});
  await expect(panel.getByRole('tab', {name:'Thông báo', exact:true})).toHaveAttribute('aria-selected','true');
  await panel.getByRole('tab', {name:'Thông báo', exact:true}).focus();
  await page.keyboard.press('End');
  const system = panel.getByRole('tab', {name:'Trạng thái hệ thống'});
  await expect(system).toBeFocused();
  hold = true;
  await panel.getByRole('button', {name:'Refresh', exact:true}).click();
  await expect(panel.getByRole('button', {name:'Refresh', exact:true})).toBeDisabled();
  await expect(panel.locator('dd')).toHaveText(Array(7).fill('—'));
  await expect.poll(() => Boolean(release)).toBe(true);
  fail = true;
  hold = false;
  release();
  await expect(panel.getByText('Synthetic refresh failure', {exact:true})).toBeVisible();
  await expect(panel.locator('dd')).toHaveText(Array(7).fill('—'));
  fail = false;
  await panel.getByRole('button', {name:'Retry', exact:true}).click();
  await expect(panel.locator('dd')).toHaveText(Array(7).fill('0'));
  await expect(system).toHaveAttribute('aria-selected','true');
  await expect(panel).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(bell).toBeFocused();
  await bell.click();
  await expect(panel.getByRole('tab', {name:'Thông báo', exact:true})).toHaveAttribute('aria-selected','true');
});
