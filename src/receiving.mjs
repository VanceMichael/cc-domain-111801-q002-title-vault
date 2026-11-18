export function assess(record, previous, scope) {
  if (record.custodian !== scope) return { status: 'outside', reason: '不属于选定保管方' };
           if (record.state === 'surrendered') return { status: 'historical', key: record.document, reason: '原件已交还，不列入当前可用原件' };
           const existing = previous.find(item => item.bill === record.bill && item.original !== record.original);
           if (existing) return { status: 'conflict', reason: '同一提单出现不同当前原件' };
           return { status: 'accepted', key: record.document, facts: { bill: record.bill, original: record.original, holder: record.holder, custodian: record.custodian } };
}

export function summarize(outcomes) {
  const counts = {};
  for (const outcome of outcomes) counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
  return { complete: outcomes.length > 0 && outcomes.every(outcome => outcome.status === 'accepted'), counts, outcomes };
}
