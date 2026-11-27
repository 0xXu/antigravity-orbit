import type { ProxyDiagnostics, ProxyMode } from '@antigravity-orbit/shared';

export function validateHttpProxyUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: 'Empty proxy URL' };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'Malformed proxy URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `Unsupported proxy protocol (${parsed.protocol}); only http:// and https:// are supported` };
  }
  return { ok: true, url: parsed.toString().replace(/\/$/, '') };
}

export function diagnoseProxy(
  config: { mode: ProxyMode; manualUrl: string },
  env: NodeJS.ProcessEnv = process.env,
): ProxyDiagnostics {
  const shellEnvUrl = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || null;

  if (config.mode === 'off') {
    return {
      mode: 'off',
      effectiveUrl: null,
      shellConflict: Boolean(shellEnvUrl),
      shellEnvUrl,
      warning: shellEnvUrl ? `Shell environment sets proxy (${shellEnvUrl}) while Antigravity Orbit proxy is off` : null,
    };
  }

  if (config.mode === 'manual') {
    const check = validateHttpProxyUrl(config.manualUrl);
    if (!check.ok) {
      return {
        mode: 'manual',
        effectiveUrl: null,
        shellConflict: false,
        shellEnvUrl,
        warning: check.reason,
      };
    }
    const conflict = Boolean(shellEnvUrl && shellEnvUrl.replace(/\/$/, '') !== check.url);
    return {
      mode: 'manual',
      effectiveUrl: check.url,
      shellConflict: conflict,
      shellEnvUrl,
      warning: conflict ? `Shell proxy (${shellEnvUrl}) overrides manual proxy (${check.url})` : null,
    };
  }

  // system mode
  return {
    mode: 'system',
    effectiveUrl: shellEnvUrl,
    shellConflict: false,
    shellEnvUrl,
    warning: null,
  };
}
