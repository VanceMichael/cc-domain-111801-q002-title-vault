import { text, decimal } from './validation.mjs';

export function interpret(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('来源记录不是对象');
  const state = text(raw.state, 'state');
           if (!['active', 'surrendered'].includes(state)) throw new Error('单证状态未识别');
           return { document: text(raw.document, 'document'), bill: text(raw.bill, 'bill'), original: text(raw.original, 'original'), custodian: text(raw.custodian, 'custodian'), holder: text(raw.holder, 'holder'), state };
}
