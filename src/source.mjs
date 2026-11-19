import { text } from './validation.mjs';

function optionalText(value, name) {
  if (value === undefined || value === null) return null;
  return text(value, name);
}

export function collectionPath(scope) {
  return '/custodian/' + encodeURIComponent(scope);
}

export async function browse(client, scope = 'A') {
  const document = await client.get(collectionPath(scope));
  const raw = document.raw;
  const context = text(raw.custodian, "custodian");
  if (!Array.isArray(raw.originals)) throw new Error('来源目录结构无效');
  const references = raw.originals.map(entry => ({
    identity: text(entry.id, 'id'),
    href: text(entry.href, 'href'),
    context,
    relations: optionalText(entry.relations, 'relations'),
  }));
  if (new Set(references.map(entry => entry.identity)).size !== references.length) throw new Error('目录包含重复来源身份');
  return { context, references, observedAt: document.observedAt, location: document.location };
}

