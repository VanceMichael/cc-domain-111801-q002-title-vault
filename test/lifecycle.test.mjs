import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceClient } from '../src/http.mjs';
import { fixtureSource } from '../src/fixture-source.mjs';
import { Archive } from '../src/archive.mjs';
import { collect } from '../src/app.mjs';

const base = JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url), 'utf8'));
const scope = 'A';

function clone() { return structuredClone(base); }

async function environment(t) {
  const directory = await mkdtemp(join(tmpdir(), 'lifecycle-'));
  const archive = await new Archive(directory).start();
  t.after(async () => { archive.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, archive };
}

test('接管过渡：新平台尚未开放时列为原件未到，旧原件不冒充当前控制原件', async (t) => {
  const fixture = clone();
  delete fixture.resources['/custodian/B/ORIG2'];
  const source = await fixtureSource(fixture);
  const { archive } = await environment(t);
  try {
    const result = await collect(new SourceClient(source.url), archive, scope);
    assert.equal(result.complete, false);
    assert.equal(result.outcomes[0].status, 'not-arrived');
    assert.equal(result.outcomes[0].current, null);
    assert.equal(result.outcomes[0].digest.length, 64);
    assert.ok(result.outcomes[0].next.includes('新原件'));
    const [record] = archive.records(scope);
    assert.equal(record.decision.status, 'not-arrived');
    assert.ok(record.decision.access.some(entry => entry.field === 'original' && entry.outcome === 'visible'));
    assert.ok(record.decision.access.some(entry => entry.field === 'target' && entry.outcome === 'absent'));
  } finally { await source.close(); }
});

test('新平台拒绝访问与原件交还相互区分', async (t) => {
  const fixture = clone();
  fixture.resources['/custodian/B/ORIG2'] = { status: 403, body: { error: '无权领取' } };
  const source = await fixtureSource(fixture);
  const { archive } = await environment(t);
  try {
    const result = await collect(new SourceClient(source.url), archive, scope);
    assert.equal(result.outcomes[0].status, 'not-arrived');
    assert.notEqual(result.outcomes[0].status, 'surrendered');
    const [record] = archive.records(scope);
    assert.equal(record.decision.access.find(entry => entry.field === 'target').outcome, 'denied');
  } finally { await source.close(); }
});

test('关联资料入口失效时保留已取得原件并标为交接尚未证实', async (t) => {
  const fixture = clone();
  delete fixture.resources['/custodian/A/relations/D1'];
  const source = await fixtureSource(fixture);
  const { archive } = await environment(t);
  try {
    const result = await collect(new SourceClient(source.url), archive, scope);
    assert.equal(result.outcomes[0].status, 'unverified');
    assert.equal(result.complete, false);
    assert.equal(archive.records(scope).length, 1);
    const original = await archive.original(result.outcomes[0].digest);
    assert.equal(JSON.parse(original.toString()).original, 'ORIG1');
    assert.ok(result.outcomes[0].next.includes('关联资料'));
  } finally { await source.close(); }
});

test('已交还的原件保留为历史副本，不列为当前', async (t) => {
  const fixture = clone();
  fixture.resources['/custodian/A/records/D1'].body.state = 'surrendered';
  fixture.resources['/custodian/A/relations/D1'] = { body: { endorsements: [], surrenders: [{ id: 'S1', original: 'ORIG1', to: 'A' }] } };
  const source = await fixtureSource(fixture);
  const { archive } = await environment(t);
  try {
    const result = await collect(new SourceClient(source.url), archive, scope);
    assert.equal(result.outcomes[0].status, 'surrendered');
    assert.equal(result.complete, false);
    assert.equal(result.outcomes[0].digest.length, 64);
    assert.ok(result.guide.surrendered.description.includes('已交还'));
  } finally { await source.close(); }
});

test('交还与背书并存时交由保管员裁定', async (t) => {
  const fixture = clone();
  delete fixture.resources['/custodian/B/ORIG2'];
  fixture.resources['/custodian/A/relations/D1'].body.surrenders = [{ id: 'S1', original: 'ORIG1', to: 'A' }];
  const source = await fixtureSource(fixture);
  const { archive } = await environment(t);
  try {
    const result = await collect(new SourceClient(source.url), archive, scope);
    assert.equal(result.outcomes[0].status, 'conflict');
    assert.ok(result.conflicts.includes('D1'));
    assert.ok(result.outcomes[0].next.includes('裁定'));
  } finally { await source.close(); }
});

test('分叉声明不按最后抓取的一页确定权属', async (t) => {
  const fixture = clone();
  fixture.resources['/custodian/A/relations/D1'].body.endorsements.push({ id: 'E3', previous: 'ORIG1', next: 'ORIG3', from: 'A', to: 'C' });
  fixture.resources['/custodian/C/ORIG3'] = { body: { document: 'D3', custodian: 'C', bill: 'BL100', original: 'ORIG3', holder: '第三方', state: 'active' } };
  const source = await fixtureSource(fixture);
  const { archive } = await environment(t);
  try {
    const result = await collect(new SourceClient(source.url), archive, scope);
    assert.equal(result.outcomes[0].status, 'conflict');
    assert.equal(result.outcomes[0].chainKind, 'fork');
    assert.equal(result.outcomes[0].current, null);
    assert.ok(result.outcomes[0].next.includes('裁定'));
  } finally { await source.close(); }
});

test('多次领取保留各自可见权限与摘要，收件结论可复查', async (t) => {
  const source = await fixtureSource(clone());
  const { archive } = await environment(t);
  try {
    const first = await collect(new SourceClient(source.url), archive, scope);
    assert.equal(first.complete, true);
    source.replace('/custodian/B/ORIG2', { status: 404, body: { error: '原件暂不存在' } });
    const second = await collect(new SourceClient(source.url), archive, scope);
    assert.equal(second.outcomes[0].status, 'not-arrived');
    assert.equal(archive.observations(scope).length, 2);
    const [history] = archive.records(scope);
    const later = history.decision;
    assert.equal(later.status, 'not-arrived');
    const dates = archive.observations(scope).map(row => row.observation.observedAt);
    assert.equal(new Set(dates).size, 2);
    assert.equal(archive.records(scope)[0].digest, first.outcomes[0].digest);
  } finally { await source.close(); }
});

test('旧平台先关闭原件入口时，用已归档依据核对新平台当前原件', async (t) => {
  const fixture = clone();
  const source = await fixtureSource(fixture);
  const { archive } = await environment(t);
  try {
    const first = await collect(new SourceClient(source.url), archive, scope);
    assert.equal(first.complete, true);
    source.replace('/custodian/A/records/D1', { status: 404, body: { error: '入口已关闭' } });
    const result = await collect(new SourceClient(source.url), archive, scope);
    assert.equal(result.complete, true);
    assert.equal(result.outcomes[0].status, 'accepted');
    assert.equal(result.outcomes[0].current.original, 'ORIG2');
    assert.notEqual(result.outcomes[0].current.digest, first.outcomes[0].digest);
    assert.ok(result.outcomes[0].copies.some(copy => copy.original === 'ORIG1' && copy.role === 'retained'));
    const observations = archive.observations(scope);
    const latest = observations.at(-1).observation;
    assert.equal(latest.status, 'accepted');
    assert.equal(latest.basis.source, 'archive');
    assert.equal(latest.basis.unavailable, 'absent');
  } finally { await source.close(); }
});

test('目录入口暂时不可取得时不把已有资料当成已交还或已删除', async (t) => {
  const fixture = clone();
  const source = await fixtureSource(fixture);
  const { archive } = await environment(t);
  try {
    const first = await collect(new SourceClient(source.url), archive, scope);
    assert.equal(first.complete, true);
    source.replace('/custodian/A', { status: 503, body: { error: '目录维护' } });
    const result = await collect(new SourceClient(source.url), archive, scope);
    assert.equal(result.complete, false);
    assert.equal(result.outcomes.at(-1).status, 'error');
    const retained = result.outcomes.filter(outcome => outcome.reference === 'D1');
    assert.equal(retained.length, 1);
    assert.equal(retained[0].status, 'unverified');
    assert.ok(retained[0].copies.some(copy => copy.original === 'ORIG1' && copy.available));
  } finally { await source.close(); }
});

test('新原件位置不属于声明的保管方时不能作为控制依据', async (t) => {
  const fixture = clone();
  fixture.resources['/custodian/A/relations/D1'] = { body: { endorsements: [{ id: 'E2', previous: 'ORIG1', next: 'ORIG2', from: 'A', to: 'B', href: '/custodian/X/ORIG2' }] } };
  fixture.resources['/custodian/X/ORIG2'] = { body: { document: 'D2', custodian: 'B', bill: 'BL100', original: 'ORIG2', holder: '进口公司', state: 'active' } };
  const source = await fixtureSource(fixture);
  const { archive } = await environment(t);
  try {
    const result = await collect(new SourceClient(source.url), archive, scope);
    assert.equal(result.outcomes[0].status, 'unverified');
    assert.ok(result.outcomes[0].reason.includes('不在声明的保管方'));
    assert.equal(result.complete, false);
  } finally { await source.close(); }
});

test('结论逐条带下一步保管来源，便于补资料', async (t) => {
  const fixture = clone();
  delete fixture.resources['/custodian/B/ORIG2'];
  const source = await fixtureSource(fixture);
  const { archive } = await environment(t);
  try {
    const result = await collect(new SourceClient(source.url), archive, scope);
    assert.equal(result.outcomes[0].nextCustodian, 'B');
    assert.ok(result.outcomes[0].next.includes('B'));
    assert.equal(result.guide['not-arrived'].description, '原件未到：交接声明已见，受控原件尚未出现');
  } finally { await source.close(); }
});
