import { createHash } from 'node:crypto';
import { interpretDocument } from './document.mjs';
import { interpretRelations, relationHref } from './relations.mjs';
import { classifyAccess } from './access.mjs';

export function custodianNamespace(location) {
  try {
    const match = /^\/custodian\/([^/]+)(?:\/|$)/.exec(new URL(location).pathname);
    return match ? decodeURIComponent(match[1]) : null;
  } catch { return null; }
}

function digestOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function accessEntry(field, location, observedAt, { error, digest, authorized, custodian }) {
  if (!error) {
    return { field, location, observedAt, outcome: 'visible', httpStatus: 200, digest: digest ?? null, authorized: authorized ?? true, custodian: custodian ?? null, reason: '可见' };
  }
  const classified = classifyAccess(error);
  return { field, location, observedAt, ...classified, digest: digest ?? null, authorized: authorized ?? null, custodian: custodian ?? null };
}

function unauthorized(field, location, observedAt, expected, actual) {
  return {
    field, location, observedAt, record: null, value: null, digest: null,
    access: {
      field, location, observedAt, outcome: 'invalid', httpStatus: 0, digest: null,
      authorized: false, custodian: actual ?? null,
      reason: '来源位置属于保管方 ' + (actual ?? '未知') + '，不在已授权来源 ' + expected + ' 之下',
    },
    failure: '来源位置不在已授权保管来源之下',
  };
}

function parseUrl(location, client) {
  const url = new URL(location, client.base);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('来源协议无效');
  if (url.origin !== client.base.origin) throw new Error('来源位置越过配置边界');
  return url.href;
}

export async function observeOriginal(client, reference) {
  const observedAt = new Date().toISOString();
  let location;
  try { location = parseUrl(reference.href, client); }
  catch (error) {
    return { field: 'original', location: reference.href, observedAt, record: null, digest: null, access: accessEntry('original', reference.href, observedAt, { error, authorized: false }) };
  }
  const actual = custodianNamespace(location);
  if (actual !== reference.context) return unauthorized('original', location, observedAt, reference.context, actual);
  try {
    const document = await client.get(location);
    const record = interpretDocument(document.raw);
    if (record.document !== reference.identity) throw new Error('原文身份与目录引用不符');
    if (record.custodian !== reference.context) throw new Error('原文上下文与目录不符');
    const digest = digestOf(document.bytes);
    return { field: 'original', location, observedAt, record, digest, document, access: accessEntry('original', location, observedAt, { digest, authorized: true, custodian: record.custodian }) };
  } catch (error) {
    return { field: 'original', location, observedAt, record: null, digest: null, access: accessEntry('original', location, observedAt, { error, authorized: true, custodian: reference.context }), failure: error.message };
  }
}

export async function observeRelations(client, reference) {
  const observedAt = new Date().toISOString();
  const hint = relationHref(reference);
  let location;
  try { location = parseUrl(hint, client); }
  catch (error) {
    return { field: 'relations', location: hint, observedAt, value: null, digest: null, access: accessEntry('relations', hint, observedAt, { error, authorized: false }) };
  }
  const actual = custodianNamespace(location);
  if (actual !== reference.context) return unauthorized('relations', location, observedAt, reference.context, actual);
  try {
    const document = await client.get(location);
    const value = interpretRelations(document.raw);
    const digest = digestOf(document.bytes);
    return { field: 'relations', location, observedAt, value, digest, document, access: accessEntry('relations', location, observedAt, { digest, authorized: true, custodian: reference.context }) };
  } catch (error) {
    return { field: 'relations', location, observedAt, value: null, digest: null, access: accessEntry('relations', location, observedAt, { error, authorized: true, custodian: reference.context }), failure: error.message };
  }
}

export async function observeOriginalAt(client, location, expected) {
  const observedAt = new Date().toISOString();
  let target;
  try { target = parseUrl(location, client); }
  catch (error) {
    return { field: 'target', location, observedAt, record: null, digest: null, access: accessEntry('target', location, observedAt, { error, authorized: false }) };
  }
  const actual = custodianNamespace(target);
  if (actual && actual !== expected.custodian) return unauthorized('target', target, observedAt, expected.custodian, actual);
  try {
    const document = await client.get(target);
    const record = interpretDocument(document.raw);
    const digest = digestOf(document.bytes);
    return { field: 'target', location: target, observedAt, record, digest, document, access: accessEntry('target', target, observedAt, { digest, authorized: true, custodian: record.custodian }) };
  } catch (error) {
    return { field: 'target', location: target, observedAt, record: null, digest: null, access: accessEntry('target', target, observedAt, { error, authorized: true, custodian: expected.custodian }), failure: error.message };
  }
}
