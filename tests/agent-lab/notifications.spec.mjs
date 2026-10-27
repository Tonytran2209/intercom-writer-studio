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
  await expect(panel.getByText('Synthetic connection failure', { exact: true })).toHaveCount(1);
  fail = false;
  await panel.getByRole('button', { name: 'Retry', exact: true }).click();
  for (const message of ['1 channel output(s) await review', '1 channel output(s) completed', '1 channel output(s) rejected']) await expect(panel.getByText(message, { exact: true })).toBeVisible();
  // Successful retry removes its button; keyboard focus must remain in the modal.
  await expect(panel).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(panel.getByRole('button', { name: 'Close notifications', exact: true })).toBeFocused();
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
