import test from 'node:test';
import assert from 'node:assert/strict';
import { interpret } from '../src/interpret.mjs';
import { evaluateChain } from '../src/chain.mjs';
import { assessChain, summarize } from '../src/receiving.mjs';

const raw = {"document": "D1", "custodian": "A", "bill": "BL100", "original": "ORIG1", "holder": "出口公司", "state": "active"};
const scope = "A";

function chain(rawEndorsements, surrenders = [], location = '/custodian/A/relations/D1') {
  return [{ location, endorsements: rawEndorsements, surrenders }];
}

test('领域记录保留明确的来源上下文', () => {
  const actual = interpret(raw);
  assert.equal(actual.custodian, raw.custodian);
  assert.equal(assessChain({ record: actual, scope, chain: null, target: null }).status, 'unverified');
});

test('交接链与可取得的受控原件相互支持时才认定为当前齐备', () => {
  const record = interpret(raw);
  const evaluated = evaluateChain(chain([{ id: 'E2', previous: 'ORIG1', next: 'ORIG2', from: 'A', to: 'B' }]), 'ORIG1');
  const target = {
    record: { document: 'D2', custodian: 'B', bill: 'BL100', original: 'ORIG2', holder: '进口公司', state: 'active' },
    expected: { original: 'ORIG2', custodian: 'B' },
    access: { outcome: 'visible', httpStatus: 200 },
  };
  const decision = assessChain({ record, scope, chain: evaluated, target });
  assert.equal(decision.status, 'accepted');
  assert.equal(decision.facts.original, 'ORIG2');
  assert.equal(decision.facts.basis.length, 1);
});

test('交接声明已见但新原件未到时不冒充当前控制原件', () => {
  const record = interpret(raw);
  const evaluated = evaluateChain(chain([{ id: 'E2', previous: 'ORIG1', next: 'ORIG2', from: 'A', to: 'B' }]), 'ORIG1');
  const absent = assessChain({ record, scope, chain: evaluated, target: { record: null, expected: { original: 'ORIG2', custodian: 'B' }, access: { outcome: 'absent' } } });
  assert.equal(absent.status, 'not-arrived');
  const denied = assessChain({ record, scope, chain: evaluated, target: { record: null, expected: { original: 'ORIG2', custodian: 'B' }, access: { outcome: 'denied' } } });
  assert.equal(denied.status, 'not-arrived');
});

test('分叉、缺环、交还与背书并存都交由保管员裁定', () => {
  const record = interpret(raw);
  const fork = evaluateChain(chain([
    { id: 'E2', previous: 'ORIG1', next: 'ORIG2', from: 'A', to: 'B' },
    { id: 'E3', previous: 'ORIG1', next: 'ORIG3', from: 'A', to: 'C' },
  ]), 'ORIG1');
  assert.equal(fork.kind, 'fork');
  assert.equal(assessChain({ record, scope, chain: fork, target: null }).status, 'conflict');

  const gap = evaluateChain(chain([
    { id: 'E2', previous: 'ORIG1', next: 'ORIG2', from: 'A', to: 'B' },
    { id: 'E4', previous: 'ORIG9', next: 'ORIG10', from: 'D', to: 'E' },
  ]), 'ORIG1');
  assert.equal(gap.kind, 'gap');
  assert.equal(assessChain({ record, scope, chain: gap, target: null }).status, 'conflict');

  const surrendered = evaluateChain(chain([], [{ id: 'S1', original: 'ORIG1', to: 'A' }]), 'ORIG1');
  assert.equal(assessChain({ record, scope, chain: surrendered, target: null }).status, 'surrendered');

  const both = evaluateChain(chain([{ id: 'E2', previous: 'ORIG1', next: 'ORIG2', from: 'A', to: 'B' }], [{ id: 'S1', original: 'ORIG1', to: 'A' }]), 'ORIG1');
  assert.equal(both.kind, 'surrender-and-endorsement');
  assert.equal(assessChain({ record, scope, chain: both, target: null }).status, 'conflict');
});

test('缺少关联资料不声明当前齐备，也不据此认定交还', () => {
  const record = interpret(raw);
  const decision = assessChain({ record, scope, chain: null, target: null });
  assert.equal(decision.status, 'unverified');
  const surrenderedRecord = interpret({ ...raw, state: 'surrendered' });
  assert.equal(assessChain({ record: surrenderedRecord, scope, chain: null, target: null }).status, 'surrendered');
});

test('链指向的原件与提单或背书身份不一致时列为争议', () => {
  const record = interpret(raw);
  const evaluated = evaluateChain(chain([{ id: 'E2', previous: 'ORIG1', next: 'ORIG2', from: 'A', to: 'B' }]), 'ORIG1');
  const wrongBill = assessChain({ record, scope, chain: evaluated, target: { record: { ...raw, document: 'D2', original: 'ORIG2', bill: 'BL999' }, expected: { original: 'ORIG2', custodian: 'B' }, access: { outcome: 'visible' } } });
  assert.equal(wrongBill.status, 'conflict');
});

test('空目录与范围外内容不声明完成', () => {
  assert.equal(summarize([]).complete, false);
  const outcome = assessChain({ record: interpret(raw), scope: 'other-scope', chain: null, target: null });
  assert.equal(summarize([outcome]).complete, false);
  assert.equal(summarize([outcome]).counts.outside, 1);
});

test('多段交接逐段核对，中间原件未取得时列原件未到', () => {
  const record = interpret(raw);
  const evaluated = evaluateChain(chain([
    { id: 'E2', previous: 'ORIG1', next: 'ORIG2', from: 'A', to: 'B' },
    { id: 'E3', previous: 'ORIG2', next: 'ORIG3', from: 'B', to: 'C' },
  ]), 'ORIG1');
  const partial = assessChain({
    record, scope, chain: evaluated,
    targets: [
      { record: { document: 'D2', custodian: 'B', bill: 'BL100', original: 'ORIG2', holder: '进口公司', state: 'active' }, access: { outcome: 'visible' }, expected: { original: 'ORIG2', custodian: 'B' } },
      { record: null, access: { outcome: 'absent' }, expected: { original: 'ORIG3', custodian: 'C' } },
    ],
  });
  assert.equal(partial.status, 'not-arrived');
  const accepted = assessChain({
    record, scope, chain: evaluated,
    targets: [
      { record: { document: 'D2', custodian: 'B', bill: 'BL100', original: 'ORIG2', holder: '进口公司', state: 'active' }, access: { outcome: 'visible' }, expected: { original: 'ORIG2', custodian: 'B' } },
      { record: { document: 'D3', custodian: 'C', bill: 'BL100', original: 'ORIG3', holder: '最终持有人', state: 'active' }, access: { outcome: 'visible' }, expected: { original: 'ORIG3', custodian: 'C' } },
    ],
  });
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.facts.original, 'ORIG3');
  assert.equal(accepted.facts.basis.length, 2);
});

test('中间原件声明已交还而链继续时列为争议', () => {
  const record = interpret(raw);
  const evaluated = evaluateChain(chain([
    { id: 'E2', previous: 'ORIG1', next: 'ORIG2', from: 'A', to: 'B' },
    { id: 'E3', previous: 'ORIG2', next: 'ORIG3', from: 'B', to: 'C' },
  ]), 'ORIG1');
  const disputed = assessChain({
    record, scope, chain: evaluated,
    targets: [
      { record: { document: 'D2', custodian: 'B', bill: 'BL100', original: 'ORIG2', holder: '进口公司', state: 'surrendered' }, access: { outcome: 'visible' }, expected: { original: 'ORIG2', custodian: 'B' } },
    ],
  });
  assert.equal(disputed.status, 'conflict');
});
