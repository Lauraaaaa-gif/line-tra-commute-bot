import { ServiceError } from './errors.mjs';

// timeout 涵蓋 headers + JSON body，第三方 API 的 redirect 一律拒絕。
export async function requestJson(url, init = {}, {
  fetchImpl = fetch, timeoutMs = 4000, signal, service = 'UPSTREAM', acceptRetryConflict = false,
} = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetchImpl(url, { ...init, signal: combined, redirect: 'error' });
    if (acceptRetryConflict && response.status === 409 && response.headers.get('x-line-accepted-request-id')) {
      await response.body?.cancel();
      return { alreadyAccepted: true };
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ServiceError(`${service}_HTTP_ERROR`, response.status);
    }
    try {
      return await response.json();
    } catch (error) {
      if (combined.aborted) throw error;
      throw new ServiceError(`${service}_INVALID_JSON`);
    }
  } catch (error) {
    if (combined.aborted) throw new ServiceError(`${service}_TIMEOUT`);
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(`${service}_NETWORK_ERROR`);
  }
}
