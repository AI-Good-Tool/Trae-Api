import { hostFor } from './client.mjs';

// Only call this with a session ID returned by this gateway's own create request.
export async function cleanupRemoteSession(
  account,
  sessionId,
  { fetcher = fetch, host = hostFor } = {},
) {
  let error = 'cleanup_failed';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetcher(
        host(account, 'agent') + '/api/remote/v1/chat_sessions/' + encodeURIComponent(sessionId),
        {
          method: 'DELETE',
          headers: {
            Authorization: 'Cloud-IDE-JWT ' + account.user.token,
            'X-Trae-Client-Type': 'web',
            'x-user-region': account.variant === 'cn' ? 'CN' : account.region || 'SG',
          },
          // Cleanup must still run when the original request has been cancelled.
          signal: AbortSignal.timeout(5000),
          redirect: 'error',
        },
      );
      if (response.status === 404 || response.status === 204) {
        await response.body?.cancel();
        return { cloudSessionCleanup: 'deleted', cloudCleanupError: null };
      }
      if (!response.ok) {
        await response.body?.cancel();
        error = 'cleanup_http_' + response.status;
        if ([401, 403].includes(response.status)) break;
        continue;
      }
      const data = await response.json();
      if (data.code === 0) return { cloudSessionCleanup: 'deleted', cloudCleanupError: null };
      error = 'cleanup_business_error';
    } catch {
      error = 'cleanup_network_error';
    }
  }
  return { cloudSessionCleanup: 'failed', cloudCleanupError: error };
}
