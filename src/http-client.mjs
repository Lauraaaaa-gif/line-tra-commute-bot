import { ServiceError } from './errors.mjs';

// Cloudflare Workers 的全域 fetch 必須以 globalThis.fetch(...) 的形式呼叫。
export function runtimeFetch(input, init) {
  return globalThis.fetch(input, init);
}

// timeout 涵蓋 headers + JSON body，第三方 API 的 redirect 一律拒絕。
export async function requestJson(url, init = {}, {
  fetchImpl = runtimeFetch, timeoutMs = 4000, signal, service = 'UPSTREAM', acceptRetryConflict = false,
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
    // Cloudflare 部署診斷：不包含 URL、headers、body 或任何憑證。
    console.error('upstream_transport_failed', {
      service,
      type: error?.constructor?.name || typeof error,
      code: typeof error?.code === 'string' ? error.code : null,
      message: String(error?.message || '').replace(/https?:\/\/\S+/g, '<url>').slice(0, 160),
    });
    throw new ServiceError(`${service}_NETWORK_ERROR`);
  }
}
