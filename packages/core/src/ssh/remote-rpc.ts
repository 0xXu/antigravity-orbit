import type { CdpClientLike } from '../cdp/client.js';

export interface SshRemoteContext {
  readonly isRemoteSsh: boolean;
  readonly host: string | null;
  readonly origin: string | null;
}

/**
 * Probes an Antigravity page target via CDP to detect 2.33+ SSH Remote windows
 * without invoking any external `ssh` binary.
 */
export async function probeSshRemoteContext(
  client: CdpClientLike,
  contextId?: number,
): Promise<SshRemoteContext> {
  const res = await client.send<{
    result?: { value?: { isRemoteSsh?: boolean; host?: string | null; origin?: string | null } };
  }>('Runtime.evaluate', {
    ...(typeof contextId === 'number' ? { contextId } : {}),
    returnByValue: true,
    expression: `(() => {
      try {
        const remote = window.sshRemote || window.__antigravitySshRemote;
        if (remote && typeof remote === 'object') {
          return {
            isRemoteSsh: true,
            host: typeof remote.host === 'string' ? remote.host : (typeof remote.authority === 'string' ? remote.authority : null),
            origin: location.origin || null,
          };
        }
        return { isRemoteSsh: false, host: null, origin: location.origin || null };
      } catch {
        return { isRemoteSsh: false, host: null, origin: null };
      }
    })()`,
  });

  const val = res.result?.value;
  return {
    isRemoteSsh: Boolean(val?.isRemoteSsh),
    host: val?.host ?? null,
    origin: val?.origin ?? null,
  };
}

/**
 * Executes a same-origin read-only RPC call inside the remote window's Isolated World.
 */
export async function invokeRemoteWindowRpc<T = unknown>(
  client: CdpClientLike,
  contextId: number,
  endpointPath: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  if (!endpointPath.startsWith('/')) {
    throw new Error(`Refusing non-relative SSH RPC path: ${endpointPath}`);
  }
  const res = await client.send<{
    result?: { value?: { ok: boolean; status: number; data?: T; error?: string } };
  }>('Runtime.evaluate', {
    contextId,
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      try {
        const r = await fetch(${JSON.stringify(endpointPath)}, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: ${JSON.stringify(JSON.stringify(body))},
          credentials: 'same-origin',
        });
        const data = r.ok ? await r.json().catch(() => null) : null;
        return { ok: r.ok, status: r.status, data };
      } catch (err) {
        return { ok: false, status: 0, error: String(err) };
      }
    })()`,
  });

  const val = res.result?.value;
  if (!val?.ok) {
    throw new Error(`SSH RPC ${endpointPath} failed (HTTP ${val?.status ?? 0}): ${val?.error ?? 'unknown'}`);
  }
  return val.data as T;
}
