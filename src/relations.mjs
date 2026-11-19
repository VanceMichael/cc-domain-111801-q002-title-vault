import { text } from './validation.mjs';

const maximumDeclarations = 64;

function optionalText(value, name) {
  if (value === undefined || value === null) return null;
  return text(value, name);
}

function normalizeNextOriginal(value) {
  const normalized = { fallback: null, byOriginal: {}, entries: [] };
  if (value === undefined || value === null) return normalized;
  if (typeof value === 'string') {
    normalized.fallback = text(value, 'nextOriginal');
    normalized.entries.push({ original: null, href: normalized.fallback });
    return normalized;
  }
  if (Array.isArray(value)) {
    if (value.length > maximumDeclarations) throw new Error('新原件位置数量超过限制');
    for (const item of value) {
      if (typeof item === 'string') {
        normalized.entries.push({ original: null, href: text(item, 'nextOriginal') });
        continue;
      }
      const original = optionalText(item?.original ?? item?.document, 'nextOriginal.original');
      const href = text(item?.href, 'nextOriginal.href');
      normalized.entries.push({ original, href });
      if (original) normalized.byOriginal[original] = href;
    }
    return normalized;
  }
  if (typeof value === 'object') {
    if (value.href !== undefined) {
      const original = optionalText(value.original ?? value.document, 'nextOriginal.original');
      const href = text(value.href, 'nextOriginal.href');
      normalized.entries.push({ original, href });
      if (original) normalized.byOriginal[original] = href;
      return normalized;
    }
    for (const [original, href] of Object.entries(value)) normalized.byOriginal[original] = text(href, 'nextOriginal.' + original);
    return normalized;
  }
  throw new Error('新原件位置结构无效');
}

function normalizeSurrenders(raw) {
  const declarations = [];
  const source = raw.surrenders ?? raw.surrender;
  if (source !== undefined && source !== null) {
    const list = Array.isArray(source) ? source : [source];
    if (list.length > maximumDeclarations) throw new Error('交还声明数量超过限制');
    for (const entry of list) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('交还声明不是对象');
      declarations.push({
        id: optionalText(entry.id, 'surrender.id'),
        original: text(entry.original ?? entry.document, 'surrender.original'),
        from: optionalText(entry.from, 'surrender.from'),
        to: optionalText(entry.to, 'surrender.to'),
        holder: optionalText(entry.holder, 'surrender.holder'),
        state: optionalText(entry.state, 'surrender.state') ?? 'surrendered',
      });
    }
  }
  if (raw.state === 'surrendered' && raw.original !== undefined) {
    declarations.push({
      id: optionalText(raw.id, 'surrender.id'),
      original: text(raw.original, 'surrender.original'),
      from: optionalText(raw.from, 'surrender.from'),
      to: optionalText(raw.to, 'surrender.to'),
      holder: optionalText(raw.holder, 'surrender.holder'),
      state: 'surrendered',
    });
  }
  return declarations;
}

export function interpretRelations(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('关联资料不是对象');
  const endorsements = [];
  if (raw.endorsements !== undefined) {
    if (!Array.isArray(raw.endorsements)) throw new Error('背书声明结构无效');
    if (raw.endorsements.length > maximumDeclarations) throw new Error('背书声明数量超过限制');
    const identifiers = new Set();
    for (const entry of raw.endorsements) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('背书声明不是对象');
      const id = text(entry.id, 'endorsements.id');
      if (identifiers.has(id)) throw new Error('背书声明编号重复：' + id);
      identifiers.add(id);
      endorsements.push({
        id,
        previous: text(entry.previous, 'endorsements.previous'),
        next: text(entry.next, 'endorsements.next'),
        from: text(entry.from, 'endorsements.from'),
        to: text(entry.to, 'endorsements.to'),
        href: optionalText(entry.href ?? entry.nextOriginal, 'endorsements.href'),
      });
    }
  }
  return {
    endorsements,
    surrenders: normalizeSurrenders(raw),
    nextOriginal: normalizeNextOriginal(raw.nextOriginal),
  };
}

export function relationHref(reference) {
  if (reference.relations) return reference.relations;
  return '/custodian/' + encodeURIComponent(reference.context) + '/relations/' + encodeURIComponent(reference.identity);
}

export function targetHref(edge, relations, { unambiguous = false } = {}) {
  if (edge.href) return edge.href;
  if (!relations) return null;
  const next = relations.nextOriginal;
  const direct = next.byOriginal?.[edge.next];
  if (direct) return direct;
  const named = next.entries.filter(entry => entry.original === edge.next);
  if (named.length === 1) return named[0].href;
  if (named.length > 1) throw new Error('同一新原件存在多个位置声明');
  const anonymous = next.entries.filter(entry => entry.original === null);
  if (anonymous.length > 0 && !unambiguous) throw new Error('关联资料未按原件区分新原件位置');
  if (anonymous.length === 1) return anonymous[0].href;
  if (anonymous.length > 1) throw new Error('关联资料无法确定新原件位置');
  return null;
}

