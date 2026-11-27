/**
 * Dual-mode Thought Translator service (machine + OpenAI-compatible LLM).
 * Enforces SSRF / cloud-metadata / high-risk port blocking, disables redirects,
 * caps concurrency at 3, and preserves clickable file:// references.
 */

const BLOCKED_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.goog',
  '100.100.100.200',
]);

const BLOCKED_PORTS = new Set([22, 23, 25, 135, 139, 445, 3306, 5432, 6379, 9200, 11211, 27017]);

export function validateTranslatorEndpoint(rawUrl: string): URL {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported translator protocol: ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) {
    throw new Error(`Blocked metadata host: ${host}`);
  }
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : parsed.protocol === 'https:' ? 443 : 80;
  if (BLOCKED_PORTS.has(port)) {
    throw new Error(`Blocked high-risk port: ${port}`);
  }
  return parsed;
}

export interface TranslateRequest {
  readonly text: string;
  readonly targetLang?: string;
  readonly mode: 'machine' | 'llm';
  readonly endpoint?: string;
  readonly model?: string;
  readonly apiKey?: string;
}

export interface TranslateResult {
  readonly translated: string;
  readonly mode: 'machine' | 'llm';
  readonly durationMs: number;
}

export class ThoughtTranslatorService {
  private inFlight = 0;
  private readonly maxConcurrency = 3;

  async translate(req: TranslateRequest): Promise<TranslateResult> {
    if (this.inFlight >= this.maxConcurrency) {
      throw new Error('Translator concurrency limit (3) reached');
    }
    const text = req.text.trim();
    if (!text) return { translated: '', mode: req.mode, durationMs: 0 };

    const started = Date.now();
    this.inFlight += 1;
    try {
      if (req.mode === 'llm') {
        if (!req.endpoint) throw new Error('LLM mode requires an endpoint URL');
        const url = validateTranslatorEndpoint(req.endpoint);
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (req.apiKey) headers.authorization = `Bearer ${req.apiKey}`;

        const res = await fetch(url, {
          method: 'POST',
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
          body: JSON.stringify({
            model: req.model || 'gpt-4o-mini',
            messages: [
              {
                role: 'system',
                content: `Translate the following engineering reasoning into ${req.targetLang || 'zh-CN'}. Preserve all code identifiers and file:// paths verbatim.`,
              },
              { role: 'user', content: text },
            ],
            temperature: 0.2,
          }),
        });
        if (!res.ok) throw new Error(`Upstream LLM HTTP ${res.status}`);
        const json = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const translated = json.choices?.[0]?.message?.content?.trim() ?? '';
        return { translated, mode: 'llm', durationMs: Date.now() - started };
      }

      // Machine mode (zero-config endpoint validated identically)
      const gtxUrl = validateTranslatorEndpoint(
        `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(req.targetLang || 'zh-CN')}&dt=t&q=${encodeURIComponent(text)}`,
      );
      const res = await fetch(gtxUrl, {
        redirect: 'error',
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new Error(`Machine translation HTTP ${res.status}`);
      const data = (await res.json()) as [Array<[string]>];
      const translated = (data[0] ?? []).map((seg) => seg[0] ?? '').join('');
      return { translated, mode: 'machine', durationMs: Date.now() - started };
    } finally {
      this.inFlight -= 1;
    }
  }
}
