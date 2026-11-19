import { browse } from './source.mjs';
import { observeOriginal, observeRelations, observeOriginalAt } from './observe.mjs';
import { evaluateChain } from './chain.mjs';
import { targetHref } from './relations.mjs';
import { assessChain, summarize, statusDescriptions } from './receiving.mjs';

async function capture(archive, observation) {
  if (archive && observation.document) await archive.preserve({ ...observation.document, digest: observation.digest });
  return observation.access;
}

function chainView(chain) {
  if (!chain) return null;
  return {
    kind: chain.kind,
    start: chain.start,
    steps: chain.steps.map(step => ({ id: step.id, previous: step.previous, next: step.next, from: step.from, to: step.to, basis: step.basis })),
    terminal: chain.terminal,
  };
}

function evidenceOf(seed, relationsObservation, handoffs) {
  return {
    original: seed.digest,
    relations: relationsObservation?.digest ?? null,
    handoffs: handoffs.map(handoff => ({
      previous: handoff.previous, next: handoff.next, custodian: handoff.custodian,
      digest: handoff.digest ?? null, access: handoff.access?.outcome ?? null,
    })),
  };
}

function latestArchived(archive, reference) {
  if (!archive) return null;
  const rows = archive.records(reference.context)
    .filter(row => row.business_key === reference.identity)
    .sort((left, right) => String(left.decision.observedAt ?? '').localeCompare(String(right.decision.observedAt ?? '')));
  const row = rows.at(-1);
  if (!row) return null;
  return { record: row.record, digest: row.digest, observedAt: row.decision.observedAt ?? null };
}

export async function inspect(client, archive, reference) {
  const access = [];
  const original = await observeOriginal(client, reference);
  access.push(await capture(archive, original));

  let seed;
  if (original.record) {
    seed = { record: original.record, digest: original.digest, source: 'source', observedAt: original.observedAt, access: original.access };
  } else {
    if (original.access.outcome === 'invalid') {
      return {
        reference: reference.identity, access, record: null, relations: null, chain: null, target: null,
        evidence: { original: null, relations: null, handoffs: [] },
        status: 'error',
        reason: '目录声明的原件入口不能作为已授权来源使用：' + original.access.reason,
        nextCustodian: original.access.custodian,
      };
    }
    const archived = latestArchived(archive, reference);
    if (!archived) {
      return {
        reference: reference.identity, access, record: null, relations: null, chain: null, target: null,
        evidence: { original: null, relations: null, handoffs: [] },
        status: 'not-arrived',
        reason: '目录声明了资料，但当前没有可取得的原件；访问未成功不能视为已交还',
        nextCustodian: reference.context,
      };
    }
    seed = {
      record: archived.record, digest: archived.digest, source: 'archive', observedAt: archived.observedAt,
      access: original.access, unavailable: original.access.outcome,
    };
  }

  const relationsObservation = await observeRelations(client, reference);
  access.push(await capture(archive, relationsObservation));
  const relationsBasis = relationsObservation.value
    ? { source: 'source', location: relationsObservation.location, observedAt: relationsObservation.observedAt, digest: relationsObservation.digest }
    : { source: 'unavailable', location: relationsObservation.location, observedAt: relationsObservation.observedAt };
  const declarations = relationsObservation.value
    ? [{ location: relationsObservation.location, endorsements: relationsObservation.value.endorsements, surrenders: relationsObservation.value.surrenders }]
    : [];
  let chain = null;
  if (declarations.length > 0) {
    try { chain = evaluateChain(declarations, seed.record.original); }
    catch (error) {
      return finish({ access, seed, relationsObservation, relationsBasis, chain: null, handoffs: [], target: null, status: 'unverified', reason: error.message, nextCustodian: reference.context });
    }
  }
  const handoffs = [];
  if (chain?.kind === 'tip') {
    for (const step of chain.steps) {
      let location = null;
      try { location = targetHref(step.edge, relationsObservation.value, { unambiguous: chain.steps.length === 1 }); }
      catch (error) {
        return finish({ access, seed, relationsObservation, relationsBasis, chain, handoffs, target: null, status: 'not-arrived', reason: error.message, nextCustodian: step.to });
      }
      if (!location) {
        return finish({ access, seed, relationsObservation, relationsBasis, chain, handoffs, target: null, status: 'not-arrived', reason: '关联资料未声明该交接的新原件位置：' + step.next, nextCustodian: step.to });
      }
      const expected = { original: step.next, custodian: step.to };
      const observation = await observeOriginalAt(client, location, expected);
      access.push(await capture(archive, observation));
      handoffs.push({ previous: step.previous, next: step.next, custodian: step.to, digest: observation.digest, access: observation.access, record: observation.record });
      if (!observation.record) break;
    }
  }
  const decision = assessChain({
    record: seed.record, scope: reference.context, chain,
    relationsAccess: relationsObservation.access,
    targets: handoffs.map(handoff => ({
      record: handoff.record, access: handoff.access,
      expected: { original: handoff.next, custodian: handoff.custodian },
    })),
  });
  const finalHandoff = handoffs.at(-1) ?? null;
  return finish({
    access, seed, relationsObservation, relationsBasis, chain, handoffs,
    target: decision.status === 'accepted' ? finalHandoff?.record ?? null : null,
    ...decision,
    nextCustodian: nextCustodianFor(decision, chain, handoffs, reference),
  });
}

function finish({ access, seed, relationsObservation, relationsBasis, chain, handoffs, ...rest }) {
  return {
    reference: seed.record?.document ?? undefined,
    access,
    record: seed.record,
    relations: relationsObservation?.value ?? null,
    chain: chainView(chain),
    relationsBasis: relationsBasis ?? null,
    evidence: evidenceOf(seed, relationsObservation, handoffs),
    basis: seed.source === 'archive'
      ? { source: 'archive', digest: seed.digest, observedAt: seed.observedAt, unavailable: seed.unavailable }
      : { source: 'source', digest: seed.digest, observedAt: seed.observedAt },
    ...rest,
  };
}

function nextCustodianFor(decision, chain, handoffs, reference) {
  if (['accepted', 'historical', 'surrendered'].includes(decision.status)) return null;
  if (handoffs.length > 0) return handoffs.at(-1).custodian;
  if (chain?.terminal?.kind === 'surrendered') return chain.terminal.surrenders?.[0]?.to ?? reference.context;
  return chain?.steps?.at(-1)?.to ?? reference.context;
}

export async function preview(client, scope = 'A') {
  const manifest = await browse(client, scope);
  const entries = [];
  for (const reference of manifest.references) {
    const observation = await inspect(client, null, reference);
    entries.push({
      reference: reference.identity,
      status: observation.status,
      reason: observation.reason,
      record: observation.record,
      chain: observation.chain,
      current: observation.status === 'accepted' ? observation.target : null,
      evidence: observation.evidence,
      access: observation.access,
      basis: observation.basis,
      nextCustodian: observation.nextCustodian ?? null,
    });
  }
  return { context: manifest.context, entries };
}

export async function collect(client, archive, scope, operator) {
  let manifest;
  try {
    manifest = await browse(client, scope);
  } catch (error) {
    return catalogFailure(error, archive, scope);
  }
  const outcomes = [];
  const listed = new Set();
  for (const reference of manifest.references) {
    const observation = await inspect(client, archive, reference);
    const key = observation.record?.document ?? reference.identity;
    listed.add(key);
    const digest = observation.record ? observation.access[0].digest : null;
    const decision = {
      status: observation.status,
      reason: observation.reason,
      ...(observation.chainKind ? { chainKind: observation.chainKind } : {}),
      ...(observation.facts ? { facts: observation.facts } : {}),
      basis: observation.basis ?? null,
      relationsBasis: observation.relationsBasis ?? null,
      nextCustodian: observation.nextCustodian ?? null,
    };
    if (operator && decision.status === 'accepted') decision.portal = await operator(observation.record);
    const copies = archivedCopies(archive, observation, digest, scope, key);
    const receipt = {
      ...decision,
      record: observation.record,
      current: observation.status === 'accepted' && observation.target
        ? { ...observation.target, digest: observation.evidence.handoffs.at(-1)?.digest ?? null }
        : null,
      chain: observation.chain,
      evidence: observation.evidence,
      access: observation.access,
      copies,
      observedAt: new Date().toISOString(),
    };
    if (digest) archive.put(scope, key, digest, observation.record, receipt);
    archive.observe(scope, key, receipt);
    outcomes.push({
      reference: reference.identity,
      digest,
      current: receipt.current,
      copies,
      ...decision,
      next: decision.status === 'accepted' ? null : describeNext(observation),
    });
  }
  const archived = archivedBeyond(archive, scope, listed);
  const summary = summarize([...outcomes, ...archived], outcomes);
  return { context: manifest.context, ...summary, guide: guide(summary) };
}

function catalogFailure(error, archive, scope) {
  const outcomes = [
    ...archivedBeyond(archive, scope, new Set(), { unconfirmed: true }),
    {
      reference: 'catalog', digest: null, status: 'error',
      reason: '来源目录不可取得：' + error.message,
      nextCustodian: scope, next: '向 ' + scope + ' 重新核对目录入口',
    },
  ];
  const summary = summarize(outcomes, []);
  return { context: scope, ...summary, guide: guide(summary) };
}

function archivedBeyond(archive, scope, listed, { unconfirmed = false } = {}) {
  if (!archive) return [];
  const grouped = new Map();
  for (const row of archive.records(scope)) {
    if (listed.has(row.business_key)) continue;
    if (!grouped.has(row.business_key)) grouped.set(row.business_key, []);
    grouped.get(row.business_key).push(row);
  }
  const outcomes = [];
  for (const [key, rows] of grouped) {
    const latest = rows.slice().sort((left, right) => String(left.decision.observedAt ?? '').localeCompare(String(right.decision.observedAt ?? ''))).at(-1);
    if (latest.decision.status === 'historical') continue;
    const copies = [...new Map(rows.slice().reverse().map(row => [row.digest, {
      digest: row.digest,
      original: row.record.original,
      available: archiveAvailable(archive, row.digest),
      role: 'retained',
      observedAt: row.decision.observedAt ?? null,
    }])).values()];
    if (latest.decision.status === 'surrendered') {
      outcomes.push({
        reference: key, digest: latest.digest, current: null, status: 'surrendered',
        reason: '原件已交还且目录不再列出，保留交还前的历史副本',
        copies, nextCustodian: null, next: null,
      });
      continue;
    }
    if (unconfirmed) {
      outcomes.push({
        reference: key, digest: latest.digest, current: null, status: 'unverified',
        reason: '来源目录当前不可取得，交接尚未证实；保留已合法取得的历史副本',
        copies, nextCustodian: scope, next: '向 ' + scope + ' 重新核对目录入口',
      });
      continue;
    }
    outcomes.push({
      reference: key, digest: latest.digest, current: null, status: 'historical',
      reason: '目录不再列出该资料，保留已合法取得的历史副本',
      copies, nextCustodian: scope, next: null,
    });
  }
  return outcomes;
}

function archivedCopies(archive, observation, digest, scope, key) {
  const copies = [];
  if (digest) {
    copies.push({
      digest,
      original: observation.record.original,
      available: archiveAvailable(archive, digest),
      role: observation.status === 'accepted' ? 'superseded' : 'retained',
      observedAt: observation.access[0].observedAt,
      basis: observation.basis?.source ?? 'source',
    });
  } else if (archive) {
    for (const prior of archive.records(scope).filter(row => row.business_key === key)) {
      copies.push({
        digest: prior.digest,
        original: prior.record.original,
        available: archiveAvailable(archive, prior.digest),
        role: 'retained',
        observedAt: prior.decision.observedAt ?? null,
        note: '原件入口当前不可取得，保留已合法取得的原文',
      });
    }
  }
  const handoffs = observation.evidence?.handoffs ?? [];
  for (let index = 0; index < handoffs.length; index += 1) {
    const handoff = handoffs[index];
    if (!handoff.digest) continue;
    const last = index === handoffs.length - 1;
    copies.push({
      digest: handoff.digest,
      original: handoff.next,
      available: archiveAvailable(archive, handoff.digest),
      role: observation.status === 'accepted' && last ? 'current' : 'superseded',
      observedAt: observation.access.find(entry => entry.field === 'target' && entry.digest === handoff.digest)?.observedAt ?? null,
    });
  }
  return copies;
}

function archiveAvailable(archive, digest) {
  if (!archive) return false;
  return Boolean(archive.database?.prepare('SELECT digest FROM evidence WHERE digest=?').get(digest));
}

function describeNext(observation) {
  if (observation.status === 'conflict') return '交保管员裁定，不自动跟随任一页';
  if (observation.status === 'not-arrived') {
    if (!observation.record) return '向 ' + observation.nextCustodian + ' 重新核对目录与原件入口';
    return '向 ' + observation.nextCustodian + ' 跟踪交接声明指向的新原件入口';
  }
  if (observation.status === 'unverified') {
    return observation.relations
      ? '向 ' + observation.nextCustodian + ' 补充交接依据或取得参与方确认'
      : '向 ' + observation.nextCustodian + ' 补取关联资料';
  }
  if (observation.status === 'error') return '向 ' + observation.nextCustodian + ' 重新核对目录与原件入口';
  if (observation.status === 'surrendered' || observation.status === 'historical') return null;
  return '向 ' + observation.nextCustodian + ' 重新核对来源资料';
}

function guide(summary) {
  return Object.fromEntries(Object.entries(summary.counts).map(([status, count]) => [status, { count, description: statusDescriptions[status] ?? status }]));
}
