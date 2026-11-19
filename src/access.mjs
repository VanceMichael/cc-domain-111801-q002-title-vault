import { SourceError } from './http.mjs';

const deniedStatuses = new Set([401, 403]);
const absentStatuses = new Set([404, 410]);

export function classifyAccess(error) {
  if (error instanceof SourceError) {
    if (deniedStatuses.has(error.status)) return { outcome: 'denied', httpStatus: error.status, reason: '来源拒绝访问，不能据此认定单证状态' };
    if (absentStatuses.has(error.status)) return { outcome: 'absent', httpStatus: error.status, reason: '来源当前未发布该位置，不能据此认定单证已交还' };
    if (error.status === 413) return { outcome: 'invalid', httpStatus: error.status, reason: '来源正文超过配置限制' };
    if (error.status === 429 || error.status >= 500) return { outcome: 'unavailable', httpStatus: error.status, reason: '来源暂时不可用，不能据此认定单证状态' };
    if (error.status === 0) return { outcome: 'unavailable', httpStatus: 0, reason: error.message };
    return { outcome: 'invalid', httpStatus: error.status, reason: error.message };
  }
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return { outcome: 'unavailable', httpStatus: 0, reason: '来源请求超时，不能据此认定单证状态' };
  }
  return { outcome: 'invalid', httpStatus: 0, reason: '来源资料无法解释：' + (error?.message ?? '未知错误') };
}

export function accessRecord({ location, field, observedAt, result, error, digest }) {
  const classification = result
    ? { outcome: 'ok', httpStatus: 200, reason: '可见' }
    : classifyAccess(error);
  return { field, location, observedAt, ...classification, digest: digest ?? null };
}
