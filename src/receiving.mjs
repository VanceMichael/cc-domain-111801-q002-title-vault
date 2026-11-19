const contested = new Set(['fork', 'gap', 'cycle', 'depth', 'surrender-and-endorsement', 'contradictory', 'discontinuity']);

function conflict(reason, kind) {
  return { status: 'conflict', reason, chainKind: kind };
}

export function assessChain({ record, scope, chain, target, targets, relationsAccess }) {
  if (record.custodian !== scope) return { status: 'outside', reason: '不属于选定保管方' };
  if (chain && contested.has(chain.kind)) return conflict(conflictReason(chain.kind), chain.kind);
  const steps = chain?.kind === 'tip' ? chain.steps : [];
  const handoffs = steps.length > 0;
  if (record.state === 'surrendered') {
    if (handoffs) return conflict('交还声明与新的背书并存', chain.kind);
    return { status: 'surrendered', reason: '执行保管方声明原件已交还，保留历史副本' };
  }
  if (!chain || chain.kind === 'absent') {
    return { status: 'unverified', reason: relationsUnavailable(relationsAccess) ?? '关联资料未声明任何交接，控制权尚未证实' };
  }
  if (chain.kind === 'unrelated') {
    return { status: 'unverified', reason: '关联资料未包含当前原件 ' + record.original + ' 的交接声明' };
  }
  if (chain.kind === 'surrendered') {
    return {
      status: 'surrendered',
      reason: (chain.steps?.length ?? 0) > 0
        ? '交接链末端原件已声明交还，不列当前；链上原文保留为历史副本'
        : '交还声明已见，原件不列当前；保留为历史副本',
    };
  }
  if (chain.kind !== 'tip') return { status: 'unverified', reason: '交接链未能得出可核对的控制原件' };
  if (!handoffs) return { status: 'unverified', reason: '关联资料未声明任何交接，控制权尚未证实' };
  if (steps[0].from !== record.custodian) {
    return conflict('交接链的起始参与方与当前保管方不一致：' + steps[0].from, chain.kind);
  }
  const observations = targets ?? (target ? [target] : []);
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const observed = observations[index];
    if (!observed) {
      return {
        status: 'not-arrived', reason: '交接声明指向的新原件尚未出现：' + step.next,
        hop: { previous: step.previous, next: step.next, custodian: step.to },
      };
    }
    if (!observed.record) {
      if (observed.access?.outcome === 'invalid' && observed.access?.authorized === false) {
        return { status: 'unverified', reason: '新原件位置不在声明的保管方之下：' + step.next, hop: { previous: step.previous, next: step.next, custodian: step.to } };
      }
      return {
        status: 'not-arrived', reason: '交接声明已见，受控原件当前不可取得：' + step.next + '；访问未成功不能视为已交还',
        hop: { previous: step.previous, next: step.next, custodian: step.to, access: observed.access?.outcome ?? null },
      };
    }
    if (observed.record.bill !== record.bill) return conflict('交接后的新原件与提单身份不一致：' + step.next, chain.kind);
    if (observed.record.original !== step.next) return conflict('来源发布的原件与背书声明不一致：' + step.next, chain.kind);
    if (observed.record.custodian !== step.to) return conflict('新原件保管方与背书声明不一致：' + step.next, chain.kind);
    if (index < steps.length - 1 && observed.record.state !== 'active') {
      return conflict('交还声明与新的背书并存：' + step.next, chain.kind);
    }
  }
  const final = observations[observations.length - 1];
  if (final.record.state !== 'active') {
    return { status: 'surrendered', reason: '交接声明指向的新原件本身已声明交还，保留历史副本' };
  }
  return {
    status: 'accepted', reason: '交接链与原件相互支持',
    facts: {
      bill: record.bill,
      original: final.record.original,
      holder: final.record.holder,
      custodian: final.record.custodian,
      basis: chain.steps.map(step => ({ id: step.id, previous: step.previous, next: step.next, from: step.from, to: step.to, source: step.basis })),
    },
  };
}

function relationsUnavailable(access) {
  if (!access) return null;
  if (access.outcome === 'denied') return '关联资料访问被拒，交接尚未证实；访问被拒不能视为单证已交还';
  if (access.outcome === 'absent') return '关联资料当前未发布，交接尚未证实；入口不存在不能视为单证已交还';
  if (access.outcome === 'unavailable') return '关联资料暂时不可取得，交接尚未证实';
  if (access.outcome === 'invalid') return '关联资料位置不能作为已授权来源使用：' + access.reason;
  return null;
}

export function conflictReason(kind) {
  if (kind === 'fork') return '同一原件存在分叉的交接声明';
  if (kind === 'gap') return '交接链存在无法闭合的中间交接';
  if (kind === 'cycle') return '交接声明形成循环';
  if (kind === 'depth') return '交接链超过可核对深度';
  if (kind === 'surrender-and-endorsement') return '交还声明与新的背书并存';
  if (kind === 'contradictory') return '同一交接存在相互冲突的参与方声明';
  if (kind === 'discontinuity') return '交接参与方不衔接，缺少中间交接';
  return '交接资料存在争议';
}

export function summarize(outcomes, current = outcomes) {
  const counts = {};
  for (const outcome of outcomes) counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
  return {
    complete: current.length > 0 && current.every(outcome => outcome.status === 'accepted'),
    counts,
    pending: outcomes.filter(outcome => ['not-arrived', 'unverified', 'error'].includes(outcome.status)).map(outcome => outcome.reference),
    conflicts: outcomes.filter(outcome => outcome.status === 'conflict').map(outcome => outcome.reference),
    outcomes,
  };
}

export const statusDescriptions = {
  accepted: '当前齐备：链与原件相互支持',
  'not-arrived': '原件未到：交接声明已见，受控原件尚未出现',
  unverified: '交接尚未证实：缺少可核对的关联资料',
  surrendered: '原件已交还：按交还声明不列当前',
  historical: '历史副本：已合法取得的原文保留复查',
  conflict: '争议：交保管员裁定，不按最后一页定权属',
  outside: '范围外：不属于本次所选保管来源',
  error: '错误：来源可见但资料无法处理',
};
