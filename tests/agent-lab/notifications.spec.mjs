import { test as offlineTest } from '@playwright/test';
import { test, expect } from './browser-fixture.mjs';

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

offlineTest('NOTIFICATIONS_OFFLINE session store and all-output review contract', async () => {
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

offlineTest('NOTIFICATIONS_OFFLINE details use live tasks, all channels and saved Discovery context', async () => {
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


offlineTest('NOTIFICATIONS_OFFLINE system counts and loading-error-recovery rendering contract', async () => {
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

// Synthetic API payloads exercise the real workspace mapping, not production samples.
test('nonempty system counts ignore board filters and update through refresh and retry', async ({ page }) => {
  const fixture = copies => {
    const data = { packages: [], articles: [], channels: [], runs: [], discovery: [] };
    for (let i = 0; i < copies; i++) {
      const packageId = state => `${state}-${i}`;
      for (const state of ['brief', 'article', 'adapt', 'review']) {
        data.packages.push({ id: packageId(state), title: `Synthetic ${state} ${i}`, state });
      }
      data.packages.push({ id: `article-extra-${i}`, title: `Synthetic extra article ${i}`, state: 'article' });
      for (const [index, status] of ['queued', 'generating', 'queued'].entries()) {
        data.channels.push({ id: `adapt-${i}-${index}`, package_id: packageId('adapt'), channel: ['threads', 'facebook', 'linkedin'][index], status, content: {} });
      }
      for (const [index, status] of ['ready', 'recheck', 'done', 'rejected'].entries()) {
        data.channels.push({ id: `review-${i}-${index}`, package_id: packageId('review'), channel: ['threads', 'facebook', 'linkedin', 'threads'][index], status, content: {} });
      }
      for (let index = 0; index < 4; index++) {
        data.discovery.push({ id: `discovery-${i}-${index}`, title: `Synthetic lead ${i}-${index}`, status: 'suggested' });
      }
    }
    return data;
  };
  let copies = 1;
  let fail = false;
  await page.route('**/api/eb-v2/workspace', route => route.fulfill(fail
    ? { status: 500, json: { error: 'Synthetic nonempty refresh failure' } }
    : { json: fixture(copies) }));
  await page.goto('/?screen=eb');
  await expect(page.getByRole('button', { name: 'Refresh V2 workspace', exact: true })).toBeEnabled();
  const bell = page.getByRole('button', { name: 'Notifications', exact: true });
  const panel = page.getByRole('dialog', { name: 'Notification center' });
  const system = panel.getByRole('tab', { name: 'Trạng thái hệ thống', exact: true });
  const labels = ['Brief', 'Article', 'Adapt', 'Review · Pending', 'Review · Completed', 'Review · Rejected', 'Discovery'];
  const assertCounts = async expected => {
    await expect(system).toHaveAttribute('aria-selected', 'true');
    await expect(panel.locator('dt')).toHaveText(labels);
    await expect(panel.locator('dd')).toHaveText(expected.map(String));
  };
  const openSystem = async () => {
    await bell.click();
    await expect(panel.getByRole('tab', { name: 'Thông báo', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(panel.getByRole('tabpanel')).not.toContainText('V2 workspace is live.');
    // Article, Adapt, three Review groups and Discovery; connection adds no entry.
    await expect(bell).toHaveText('6');
    await system.click();
  };
  await openSystem();
  await assertCounts([1, 2, 3, 2, 1, 1, 4]);
  await page.keyboard.press('Escape');
  // Exercise workflow, channel and decision filters together. Review retains only
  // its done LinkedIn output on the board, while status must retain every output.
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  for (const name of ['Review · Gate 3', 'LinkedIn', 'Done']) {
    await page.getByRole('button', { name, exact: true }).click();
  }
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await expect(page.getByText('Synthetic brief 0', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Synthetic article 0', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Synthetic review 0', { exact: true })).toBeVisible();
  await openSystem();
  await assertCounts([1, 2, 3, 2, 1, 1, 4]);
  copies = 2;
  await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
  await assertCounts([2, 4, 6, 4, 2, 2, 8]);
  fail = true;
  await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(panel.getByText('Synthetic nonempty refresh failure', { exact: true })).toBeVisible();
  await assertCounts(Array(7).fill('—'));
  copies = 3;
  fail = false;
  await panel.getByRole('button', { name: 'Retry', exact: true }).click();
  await assertCounts([3, 6, 9, 6, 3, 3, 12]);
  await expect(panel.getByText('V2 workspace is live.', { exact: true })).toBeVisible();
  await expect(panel.getByText(/counts are unconfirmed/)).toHaveCount(0);
});

// Full workspace module with mocked React hooks/API boundaries, no function extraction
// and no browser fixture. These synthetic failures are not production reproductions.
offlineTest('NOTIFICATIONS_OFFLINE operation failures preserve review results and connection isolation', async () => {
  const { readFile } = await import('node:fs/promises');
  const { strict: assert } = await import('node:assert');
  const ts = (await import('typescript')).default;
  const jsx = await import('react/jsx-runtime');
  const source = await readFile('src/components/EbWorkingSpace.tsx', 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const slots = [], refs = [], events = [];
  let cursor = 0, refCursor = 0, tree, failRead = false;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) { const index = refCursor++; return refs[index] ??= { current: initial }; },
    useEffect() {},
  };
  const data = { packages: [{ id:'brief', title:'Synthetic brief', state:'brief' }, { id:'review', title:'Synthetic review', state:'review' }], articles:[], runs:[], discovery:[], channels: ['facebook','linkedin'].map((channel, i) => ({id:`c${i}`, package_id:'review', channel, status:'ready', content:{}})) };
  let reviewCalls = 0;
  const api = {
    async fetchEbV2Workspace() { if (failRead) throw new Error('Synthetic connection'); return data; },
    async runEbV2DiscoveryLive() { throw new Error('Synthetic Discovery'); },
    async approveEbV2Brief() { throw new Error('Synthetic approval'); },
    async reviewEbV2Channel(id) {
      reviewCalls++;
      if (id === 'c1') throw new Error('Synthetic review');
      data.channels[0].status = 'done';
      return data;
    },
  };
  const module = { exports:{} };
  const dependencies = {
    'react':hooks, 'react/jsx-runtime':jsx, 'lucide-react':{}, '../lib/db':api,
    '../lib/appMode':{isShellMode:false}, '../lib/ebGateContent':{},
    './workspace/WorkspaceNotification':{
      useWorkspaceNotices:() => events,
      notifyWorkspace:(message, kind) => events.push({id:events.length + 1, message, kind}),
    },
  };
  new Function('require', 'exports', compiled)(name => {
    assert.ok(name in dependencies, `Unexpected dependency ${name}`);
    return dependencies[name];
  }, module.exports);
  const config = {stepConfigs:{}, models:[{id:'mock', provider:'mock', enabled:true}]};
  const render = () => { cursor = 0; refCursor = 0; tree = module.exports.default({config}); };
  const nodes = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
  const find = predicate => { const node = nodes(tree).find(predicate); assert.ok(node, 'Expected workspace element'); return node.props; };
  const component = name => find(node => node.type?.name === name);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const refresh = async () => {
    find(node => /^(Refresh V2 workspace|Retry V2 connection)$/.test(node.props?.['aria-label'])).onClick();
    await flush(); render();
  };
  render(); await refresh();
  const group = () => component('GateGroup');
  const brief = group().tasks[0];
  group().onBrief(brief); await flush(); render();
  assert.equal(events.length, 1);
  assert.match(events[0].message, /Approve brief.*Synthetic brief.*Synthetic approval/);
  assert.equal(events[0].kind, 'error');
  assert.ok(nodes(tree).some(n => n.props?.['aria-label'] === 'Refresh V2 workspace'));
  const review = nodes(tree).find(n => n.type?.name === 'GateGroup' && n.props.gate === 'review').props.tasks[0];
  group().onDecision(review.id, 'done'); await flush(); render();
  assert.equal(events.length, 2);
  assert.equal(reviewCalls, 2);
  assert.match(events[1].message, /Synthetic review.*Facebook, LinkedIn.*1\/2 review action\(s\) confirmed/);
  assert.equal(data.channels[0].status, 'done');
  group().onDecision(review.id, 'done'); await flush(); render();
  assert.equal(reviewCalls, 3, 'Retry skips the confirmed output');
  assert.equal(events.length, 3, 'One event for each failed attempt');
  // Select Discovery through the mocked hook host; execute its real callback.
  slots[1] = 'discovery'; render();
  component('DiscoveryResearch').onDiscover(); await flush(); render();
  assert.equal(events.length, 4);
  assert.match(events[3].message, /Discovery.*Synthetic Discovery/);
  await refresh();
  assert.equal(events.length, 4, 'Successful reads retain history without adding events');
  failRead = true; await refresh();
  assert.equal(events.length, 4, 'Connection failure does not add an event');
  assert.ok(nodes(tree).some(n => n.props?.['aria-label'] === 'Retry V2 connection'));
  failRead = false; await refresh();
  find(node => node.props?.['aria-label'] === 'Notifications').onClick(); render();
  const panel = component('NotificationPanel');
  assert.equal(panel.runtimeError, null);
  assert.equal(panel.notices.filter(n => n.id.startsWith('event-')).length, 4);
  assert.equal(panel.notices.filter(n => n.error).length, 4);
});

// Executed by browser-check CI on desktop/mobile; synthetic API failures only.
test('operation errors enter notification details once and survive refresh', async ({ page }) => {
  const data = {packages:[{id:'b', title:'Synthetic brief', state:'brief'}, {id:'r', title:'Synthetic review', state:'review'}], articles:[], runs:[], discovery:[], channels:['facebook','linkedin'].map((channel,i) => ({id:`c${i}`,package_id:'r',channel,status:'ready',content:{}}))};
  let failRead = false;
  await page.route('**/api/eb-v2/workspace', route => route.fulfill(failRead ? {status:500,json:{error:'Synthetic connection'}} : {json:data}));
  await page.route('**/api/eb-v2/packages/b/approve-brief', route => route.fulfill({status:500,json:{error:'Synthetic approval'}}));
  await page.route('**/api/eb-v2/discovery', route => route.fulfill({contentType:'application/x-ndjson',body:JSON.stringify({event:'error',error:'Synthetic Discovery'}) + '\n'}));
  await page.route('**/api/eb-v2/channel-outputs/*/review', route => {
    if (route.request().url().includes('/c1/')) return route.fulfill({status:500,json:{error:'Synthetic review'}});
    data.channels[0].status = 'done';
    return route.fulfill({json:data});
  });
  await page.goto('/?screen=eb');
  await expect(page.getByRole('button',{name:'Refresh V2 workspace',exact:true})).toBeEnabled();
  const bell = page.getByRole('button',{name:'Notifications',exact:true});
  const panel = page.getByRole('dialog',{name:'Notification center'});
  const assertEvent = async (pattern, count) => {
    await bell.click();
    const row = panel.getByRole('button').filter({hasText:pattern});
    await expect(row).toHaveCount(1);
    await expect(panel.getByRole('button').filter({hasText:/Refresh workspace to check saved state/})).toHaveCount(count);
    await row.click();
    await expect(panel.getByRole('region',{name:'Notification details'})).toContainText(pattern);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button',{name:'Refresh V2 workspace',exact:true})).toBeEnabled();
  };
  await page.getByRole('button',{name:'Approve brief',exact:true}).click();
  await assertEvent(/Synthetic approval/,1);
  const card = page.locator('article').filter({has:page.getByRole('button',{name:'Open task: Synthetic review',exact:true})});
  await card.getByRole('button',{name:'More item actions',exact:true}).click();
  await card.getByRole('button',{name:'Done tất cả',exact:true}).click();
  await assertEvent(/1\/2 review action\(s\) confirmed/,2);
  await expect(card).toContainText('1 Done');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('writer:eb-open',{detail:'discovery'})));
  await page.getByRole('button',{name:'Scan sources',exact:true}).click();
  await assertEvent(/Synthetic Discovery/,3);
  await page.getByRole('button',{name:'Refresh V2 workspace',exact:true}).click();
  await expect(page.getByRole('button',{name:'Refresh V2 workspace',exact:true})).toBeEnabled();
  await bell.click();
  await expect(panel.getByRole('button').filter({hasText:/Refresh workspace to check saved state/})).toHaveCount(3);
  const badge = await bell.textContent();
  await panel.getByRole('tab',{name:'Trạng thái hệ thống'}).click();
  failRead = true;
  await panel.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(panel.getByText('Synthetic connection',{exact:true})).toBeVisible();
  failRead = false;
  await panel.getByRole('button',{name:'Retry',exact:true}).click();
  await expect(panel.getByText('V2 workspace is live.',{exact:true})).toBeVisible();
  await expect(bell).toHaveText(badge);
  await panel.getByRole('tab',{name:'Thông báo',exact:true}).click();
  await expect(panel.getByRole('button').filter({hasText:/Refresh workspace to check saved state/})).toHaveCount(3);
});
