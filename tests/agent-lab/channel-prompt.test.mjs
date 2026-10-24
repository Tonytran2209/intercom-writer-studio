import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

// Synthetic contract checks only: no backend import, environment, or provider calls.
const source = readFileSync(new URL('../../backend/ebV2.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('ebV2.ts', source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'adaptTask');
assert.ok(declaration, 'shared adaptation task must exist');
const javascript = ts.transpileModule(declaration.getText(ast), {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
}).outputText;
const adaptTask = runInNewContext(`${javascript}\nadaptTask`, Object.create(null));
const article = 'Synthetic approved article mentioning Facebook, Threads and LinkedIn.';
for (const channel of ['facebook', 'threads', 'linkedin']) {
  test(`${channel}: a single target despite multi-channel context`, () => {
    const task = adaptTask(channel, article);
    assert.ok(task.startsWith(`TARGET CHANNEL: ${channel}\n`));
    assert.ok(task.includes(`Return content for ${channel} only.`));
    assert.ok(task.includes(`apply only the rules for ${channel}.`));
    assert.ok(task.includes('Do not return a bundle of posts for multiple channels'));
    assert.ok(task.includes('sections intended for another channel.'));
    assert.ok(task.includes('References to other platforms within the requested post are allowed.'));
    assert.ok(task.includes('Those configured rules take precedence over the fallback delivery contract below, editorial learnings, the current output, and editor feedback.'));
    assert.ok(task.includes('FALLBACK (only where configured Channel Rules do not specify otherwise):'));
    assert.ok(task.endsWith(`APPROVED ARTICLE:\n${article}`));
    const contracts = task.match(/(?:FACEBOOK|THREADS|LINKEDIN) DELIVERY CONTRACT/g);
    assert.deepEqual(contracts, [`${channel.toUpperCase()} DELIVERY CONTRACT`]);
    if (channel === 'facebook') assert.match(task, /Vietnamese post first, followed by its English translation/);
    if (channel === 'threads') {
      assert.match(task, /Vietnamese only/);
      assert.match(task, /exactly two labelled variants: Variant A — Company account and Variant B — Employee-shareable/);
      assert.match(task, /at most 500 characters/);
    }
    if (channel === 'linkedin') assert.match(task, /English only\. Return one credibility-led/);
  });
}
test('initial generation, regeneration and feedback share the task contract', () => {
  const calls = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'adaptTask') calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  // Feedback embeds the call in a template; the other two callers pass it directly.
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(call => call.arguments[0].getText(ast)).sort(), ['channel.channel', 'output.channel', 'output.channel']);
  assert.match(source, /`feedback:\$\{channel.channel\}`/);
  assert.match(source, /App Settings workflow rules take precedence over library rules where they conflict/);
});
