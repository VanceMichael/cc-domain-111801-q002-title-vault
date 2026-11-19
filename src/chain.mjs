const maximumDepth = 12;

function collectEdges(declarations) {
  const edges = [];
  const surrenders = [];
  for (const declaration of declarations ?? []) {
    for (const endorsement of declaration.endorsements ?? []) edges.push({ ...endorsement, declaration });
    for (const item of declaration.surrenders ?? []) surrenders.push({ ...item, declaration });
  }
  return { edges, surrenders };
}

function indexBy(list, field) {
  const index = new Map();
  for (const item of list) {
    if (!index.has(item[field])) index.set(item[field], []);
    index.get(item[field]).push(item);
  }
  return index;
}

function declaredOriginals(edges, surrenders) {
  const originals = new Set();
  for (const edge of edges) { originals.add(edge.previous); originals.add(edge.next); }
  for (const item of surrenders) originals.add(item.original);
  return originals;
}

function connectedOriginals(start, edgesByPrevious, edges) {
  const reachable = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const edge of edgesByPrevious.get(current) ?? []) {
      if (!reachable.has(edge.next)) { reachable.add(edge.next); queue.push(edge.next); }
    }
  }
  const ancestors = new Set([start]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (ancestors.has(edge.next) && !ancestors.has(edge.previous)) { ancestors.add(edge.previous); changed = true; }
    }
  }
  return new Set([...reachable, ...ancestors]);
}

function walk(original, visited, edgesByPrevious, surrendersByOriginal, handedBy) {
  if (visited.has(original)) return { kind: 'cycle', original };
  if (visited.size >= maximumDepth) return { kind: 'gap', original, limit: true };
  const outgoing = edgesByPrevious.get(original) ?? [];
  const nexts = [...new Set(outgoing.map(edge => edge.next))].sort();
  const surrenders = surrendersByOriginal.get(original) ?? [];
  if (nexts.length > 1) return { kind: 'fork', original, nexts, edges: outgoing };
  if (nexts.length === 1 && surrenders.length > 0) {
    return { kind: 'surrender-and-endorsement', original, edge: outgoing[0], edges: outgoing, surrenders };
  }
  if (nexts.length === 1) {
    const parties = new Set(outgoing.map(edge => edge.from + '\u0000' + edge.to));
    if (parties.size > 1) return { kind: 'contradictory', original, edges: outgoing, surrenders };
    const edge = outgoing[0];
    if (handedBy !== undefined && edge.from !== handedBy) {
      return { kind: 'discontinuity', original, edges: outgoing, surrenders, parties: [handedBy, edge.from] };
    }
    const rest = walk(edge.next, new Set([...visited, original]), edgesByPrevious, surrendersByOriginal, edge.to);
    return { kind: 'edge', original, edge, edges: outgoing, rest };
  }
  if (surrenders.length > 0) return { kind: 'surrendered', original, surrenders };
  return { kind: 'tip', original };
}

function flatten(tree) {
  const steps = [];
  let node = tree;
  while (node.kind === 'edge') {
    steps.push({
      id: node.edge.id ?? null,
      previous: node.original,
      next: node.edge.next,
      from: node.edge.from,
      to: node.edge.to,
      edge: node.edge,
      declaration: node.edge.declaration,
      basis: node.edge.declaration?.location ?? null,
    });
    node = node.rest;
  }
  return { terminal: node, steps };
}

export function evaluateChain(declarations, start) {
  const original = typeof start === 'string' ? start : start?.original;
  if (!original) throw new Error('缺少待核对的原文身份');
  const { edges, surrenders } = collectEdges(declarations);
  if (edges.length === 0 && surrenders.length === 0) {
    return { kind: 'absent', start: original, originals: [original], steps: [], terminal: { kind: 'absent', original } };
  }
  const edgesByPrevious = indexBy(edges, 'previous');
  const surrendersByOriginal = indexBy(surrenders, 'original');
  const declared = declaredOriginals(edges, surrenders);
  if (!declared.has(original)) {
    return { kind: 'unrelated', start: original, originals: [...declared].sort(), steps: [], terminal: { kind: 'unrelated', original, declared: [...declared].sort() } };
  }
  const connected = connectedOriginals(original, edgesByPrevious, edges);
  const disconnected = [...declared].filter(item => !connected.has(item)).sort();
  if (disconnected.length > 0) {
    return {
      kind: 'gap', start: original, originals: [...connected], steps: [],
      terminal: { kind: 'gap', original, disconnected },
    };
  }
  const { terminal, steps } = flatten(walk(original, new Set(), edgesByPrevious, surrendersByOriginal, undefined));
  return { kind: terminal.kind, start: original, originals: [...connected], steps, terminal };
}

