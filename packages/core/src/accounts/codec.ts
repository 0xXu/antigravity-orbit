/**
 * Antigravity OAuth & UnifiedStateSync Protobuf + Go-Keyring Codec.
 *
 * Handles bidirectional conversion between:
 * 1. `state.vscdb` ItemTable topic rows (`antigravityUnifiedStateSync.oauthToken`,
 *    `antigravityUnifiedStateSync.userStatus`, `antigravityUnifiedStateSync.enterprisePreferences`)
 * 2. macOS / Windows `go-keyring` Keychain credentials (`gemini` / `antigravity`)
 * 3. `agy` CLI standalone OAuth JSON credentials
 */

export interface OAuthTokenData {
  access_token: string;
  token_type: string;
  refresh_token: string;
  expiry_timestamp: number;
  expires_in: number;
  email?: string | null;
  project_id?: string | null;
  is_gcp_tos?: boolean;
  id_token?: string | null;
}

export const SENTINEL_OAUTH_TOKEN = 'oauthTokenInfoSentinelKey';
export const SENTINEL_USER_STATUS = 'userStatusSentinelKey';
export const SENTINEL_ENTERPRISE_PROJECT = 'enterpriseGcpProjectId';
export const WINDOWS_CRED_MAX_BYTES = 2560;

// ---------------------------------------------------------------------------
// Minimal wire-level Protobuf Reader / Writer
// ---------------------------------------------------------------------------

export function readVarint(buf: Buffer, offset: number): [number, number] | null {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++]!;
    if (shift <= 63n) {
      result |= BigInt(byte & 0x7f) << shift;
    } else {
      return null;
    }
    shift += 7n;
    if ((byte & 0x80) === 0) {
      const asInt = BigInt.asIntN(64, result);
      if (result <= BigInt(Number.MAX_SAFE_INTEGER)) return [Number(result), pos];
      if (asInt >= BigInt(Number.MIN_SAFE_INTEGER) && asInt <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return [Number(asInt), pos];
      }
      return [Number(result), pos];
    }
  }
  return null;
}

export function findProtobufField(buf: Buffer, targetField: number): Buffer | null {
  let offset = 0;
  while (offset < buf.length) {
    const tag = readVarint(buf, offset);
    if (!tag) break;
    const [t, next] = tag;
    const wire = t & 0x07;
    const fieldNo = t >>> 3;
    if (wire === 2) {
      const len = readVarint(buf, next);
      if (!len || !Number.isSafeInteger(len[0]) || len[0] < 0 || len[1] + len[0] > buf.length) break;
      const end = len[1] + len[0];
      if (fieldNo === targetField) return buf.subarray(len[1], end);
      offset = end;
    } else if (wire === 0) {
      const v = readVarint(buf, next);
      if (!v) break;
      offset = v[1];
    } else if (wire === 1) {
      offset = next + 8;
    } else if (wire === 5) {
      offset = next + 4;
    } else {
      break;
    }
  }
  return null;
}

export function findProtobufVarint(buf: Buffer, targetField: number): number | null {
  let offset = 0;
  while (offset < buf.length) {
    const tag = readVarint(buf, offset);
    if (!tag) break;
    const [t, next] = tag;
    const wire = t & 0x07;
    const fieldNo = t >>> 3;
    if (wire === 0) {
      const v = readVarint(buf, next);
      if (!v) break;
      if (fieldNo === targetField) return v[0];
      offset = v[1];
    } else if (wire === 2) {
      const len = readVarint(buf, next);
      if (!len || !Number.isSafeInteger(len[0]) || len[0] < 0 || len[1] + len[0] > buf.length) break;
      offset = len[1] + len[0];
    } else if (wire === 1) {
      offset = next + 8;
    } else if (wire === 5) {
      offset = next + 4;
    } else {
      break;
    }
  }
  return null;
}

export function findProtobufString(buf: Buffer, targetField: number): string | null {
  const fieldBuf = findProtobufField(buf, targetField);
  if (!fieldBuf) return null;
  return fieldBuf.toString('utf8').trim() || null;
}

export function encodeVarint(value: number | bigint): Buffer {
  let v = typeof value === 'bigint' ? value : BigInt(Math.max(0, Math.floor(value)));
  const bytes: number[] = [];
  while (v >= 0x80n) {
    bytes.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  bytes.push(Number(v & 0x7fn));
  return Buffer.from(bytes);
}

export function encodeLengthDelimited(fieldNumber: number, payload: Buffer): Buffer {
  const tag = encodeVarint((fieldNumber << 3) | 2);
  const len = encodeVarint(payload.length);
  return Buffer.concat([tag, len, payload]);
}

export function encodeString(fieldNumber: number, text: string): Buffer {
  return encodeLengthDelimited(fieldNumber, Buffer.from(text, 'utf8'));
}

export function encodeVarintField(fieldNumber: number, value: number | bigint): Buffer {
  const tag = encodeVarint((fieldNumber << 3) | 0);
  return Buffer.concat([tag, encodeVarint(value)]);
}

// ---------------------------------------------------------------------------
// UnifiedStateSync Topic Row helpers (`antigravityUnifiedStateSync.*`)
// ---------------------------------------------------------------------------

function parseTopicValue(value: string | undefined): { wrapper?: Record<string, unknown>; encoded: string } {
  let wrapper: Record<string, unknown> | undefined;
  let encoded = (value ?? '').trim();
  if (encoded.startsWith('{')) {
    const parsed = JSON.parse(encoded) as Record<string, unknown>;
    if (typeof parsed?.data !== 'string') {
      throw new Error('Invalid topic JSON wrapper');
    }
    wrapper = parsed;
    encoded = parsed.data.trim();
  }
  if (encoded && !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error('Invalid topic base64 encoding');
  }
  return { wrapper, encoded };
}

function filterTopicEntries(encoded: string, sentinel: string): Buffer[] {
  if (!encoded) return [];
  const data = Buffer.from(encoded, 'base64');
  const keep: Buffer[] = [];
  let offset = 0;
  while (offset < data.length) {
    const start = offset;
    const tag = readVarint(data, offset);
    if (!tag) throw new Error('Truncated topic protobuf entry');
    const [field, pos] = tag;
    const wire = field & 7;
    let content: Buffer | undefined;
    if (wire === 2) {
      const size = readVarint(data, pos);
      if (!size || size[1] + size[0] > data.length) throw new Error('Truncated topic length-delimited field');
      offset = size[1] + size[0];
      content = data.subarray(size[1], offset);
    } else if (wire === 0) {
      const v = readVarint(data, pos);
      if (!v) throw new Error('Truncated topic varint field');
      offset = v[1];
    } else if (wire === 1) {
      offset = pos + 8;
    } else if (wire === 5) {
      offset = pos + 4;
    } else {
      throw new Error('Invalid topic wire type');
    }
    if (offset > data.length) throw new Error('Topic field overflows buffer');
    // Tag 10 = field 1, wire type 2
    if (!(field === 10 && content && findProtobufString(content, 1) === sentinel)) {
      keep.push(data.subarray(start, offset));
    }
  }
  return keep;
}

export function decodeTopicRow(value: string | undefined, sentinel: string): Buffer | null {
  if (!value) return null;
  let encoded = value.trim();
  if (!encoded) return null;
  if (encoded.startsWith('{')) {
    try {
      const parsed = JSON.parse(encoded) as { data?: unknown };
      if (typeof parsed?.data !== 'string') return null;
      encoded = parsed.data.trim();
    } catch {
      return null;
    }
  }
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  const data = Buffer.from(encoded, 'base64');
  let offset = 0;
  while (offset < data.length) {
    const tag = readVarint(data, offset);
    if (!tag) break;
    const [field, pos] = tag;
    const wire = field & 7;
    let content: Buffer | undefined;
    if (wire === 2) {
      const size = readVarint(data, pos);
      if (!size || size[1] + size[0] > data.length) break;
      offset = size[1] + size[0];
      content = data.subarray(size[1], offset);
    } else if (wire === 0) {
      const v = readVarint(data, pos);
      if (!v) break;
      offset = v[1];
    } else if (wire === 1) {
      offset = pos + 8;
      if (offset > data.length) break;
    } else if (wire === 5) {
      offset = pos + 4;
      if (offset > data.length) break;
    } else {
      break;
    }
    if (field !== 10 || !content) continue;
    if (findProtobufString(content, 1) !== sentinel) continue;
    const row = findProtobufField(content, 2);
    if (!row) return null;
    const payload = findProtobufString(row, 1);
    if (payload && /^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
      return Buffer.from(payload, 'base64');
    }
    return row;
  }
  return null;
}

export function replaceTopicRow(value: string | undefined, sentinel: string, payload: Buffer): string {
  let wrapper: Record<string, unknown> | undefined;
  let keep: Buffer[] = [];
  if (value) {
    try {
      const parsed = parseTopicValue(value);
      wrapper = parsed.wrapper;
      keep = filterTopicEntries(parsed.encoded, sentinel);
    } catch {
      keep = [];
    }
  }
  const row = encodeString(1, payload.toString('base64'));
  keep.push(
    encodeLengthDelimited(
      1,
      Buffer.concat([encodeString(1, sentinel), encodeLengthDelimited(2, row)]),
    ),
  );
  const result = Buffer.concat(keep).toString('base64');
  return wrapper ? JSON.stringify({ ...wrapper, data: result }) : result;
}

export function removeTopicRow(value: string | undefined, sentinel: string): string | null {
  if (!value) return null;
  try {
    const { wrapper, encoded } = parseTopicValue(value);
    if (!encoded) return null;
    const keep = filterTopicEntries(encoded, sentinel);
    if (keep.length === 0) return null;
    const result = Buffer.concat(keep).toString('base64');
    return wrapper ? JSON.stringify({ ...wrapper, data: result }) : result;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// High-level OAuth / UserStatus / Enterprise / Keychain conversion
// ---------------------------------------------------------------------------

export function decodeJwtEmail(idToken?: string | null): string | null {
  if (!idToken || typeof idToken !== 'string') return null;
  const parts = idToken.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as {
      email?: unknown;
    };
    return typeof payload.email === 'string' && payload.email.includes('@')
      ? payload.email.trim().toLowerCase()
      : null;
  } catch {
    return null;
  }
}

export function decodeOAuthTokenFromTopicRow(
  rawTopicValue: string | undefined,
  opts?: { email?: string | null; projectId?: string | null },
): OAuthTokenData | null {
  const payload = decodeTopicRow(rawTopicValue, SENTINEL_OAUTH_TOKEN);
  if (!payload) return null;
  const accessToken = findProtobufString(payload, 1) ?? '';
  const tokenType = findProtobufString(payload, 2) ?? 'Bearer';
  const refreshToken = findProtobufString(payload, 3) ?? '';
  if (!refreshToken) return null;
  const idToken = findProtobufString(payload, 5) ?? null;
  const gcpTosFlag = findProtobufVarint(payload, 6);
  const nowSec = Math.floor(Date.now() / 1000);
  let expirySec = 0;
  const timeBuf = findProtobufField(payload, 4);
  if (timeBuf) {
    const sec = findProtobufVarint(timeBuf, 1);
    if (sec !== null && sec >= 0) expirySec = sec;
  }
  const email = (decodeJwtEmail(idToken) ?? opts?.email?.trim().toLowerCase()) || null;
  return {
    access_token: accessToken,
    token_type: tokenType,
    refresh_token: refreshToken,
    expiry_timestamp: expirySec,
    expires_in: expirySec > nowSec ? expirySec - nowSec : 0,
    email,
    project_id: opts?.projectId ?? null,
    is_gcp_tos: Boolean(gcpTosFlag && gcpTosFlag > 0),
    id_token: idToken,
  };
}

export function encodeOAuthTokenToTopicRow(
  existingTopicValue: string | undefined,
  token: OAuthTokenData,
  email: string,
): string {
  const personal = /@(gmail|outlook|hotmail|qq|163)\.com$/i.test(email);
  const accessToken =
    token.access_token && token.access_token !== 'pending_refresh' ? token.access_token : '';
  const expirySec =
    Number.isFinite(token.expiry_timestamp) && token.expiry_timestamp > 0
      ? Math.floor(token.expiry_timestamp)
      : 0;
  const payload = Buffer.concat([
    encodeString(1, accessToken),
    encodeString(2, token.token_type || 'Bearer'),
    encodeString(3, token.refresh_token),
    encodeLengthDelimited(
      4,
      Buffer.concat([encodeVarintField(1, expirySec), encodeVarintField(2, 0)]),
    ),
    ...(token.id_token ? [encodeString(5, token.id_token)] : []),
    encodeVarintField(6, !personal && token.is_gcp_tos ? 1 : 0),
  ]);
  return replaceTopicRow(existingTopicValue, SENTINEL_OAUTH_TOKEN, payload);
}

export function decodeUserStatusFromTopicRow(
  rawUserStatus: string | undefined,
): { name: string | null; email: string | null } {
  const payload = decodeTopicRow(rawUserStatus, SENTINEL_USER_STATUS);
  if (payload) {
    const name = findProtobufString(payload, 3);
    const email = findProtobufString(payload, 7);
    if (email && email.includes('@')) {
      return { name, email: email.trim().toLowerCase() };
    }
  }
  return { name: null, email: null };
}

export function encodeUserStatusTopicRow(name: string, email: string): string {
  const normalizedEmail = email.trim().toLowerCase();
  const displayName = name.trim() || normalizedEmail;
  const payload = Buffer.concat([encodeString(3, displayName), encodeString(7, normalizedEmail)]);
  return replaceTopicRow(undefined, SENTINEL_USER_STATUS, payload);
}

export function decodeEnterpriseProjectId(rawEnterprise: string | undefined): string | null {
  const payload = decodeTopicRow(rawEnterprise, SENTINEL_ENTERPRISE_PROJECT);
  if (!payload) return null;
  return findProtobufString(payload, 3);
}

export function encodeEnterpriseTopicRow(
  existingValue: string | undefined,
  projectId: string | null | undefined,
): string | null {
  if (projectId) {
    return replaceTopicRow(existingValue, SENTINEL_ENTERPRISE_PROJECT, encodeString(3, projectId));
  }
  if (existingValue !== undefined) {
    return removeTopicRow(existingValue, SENTINEL_ENTERPRISE_PROJECT);
  }
  return null;
}

export function decodeKeychainOauthJson(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('go-keyring-base64:')) {
    try {
      return Buffer.from(trimmed.slice('go-keyring-base64:'.length), 'base64').toString('utf8');
    } catch {
      return null;
    }
  }
  if (trimmed.startsWith('{')) {
    return trimmed;
  }
  return null;
}

export function parseOAuthJson(rawJson: string | null | undefined): {
  token: OAuthTokenData;
  email: string | null;
} | null {
  if (!rawJson) return null;
  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    const rawToken =
      parsed.token && typeof parsed.token === 'object' && !Array.isArray(parsed.token)
        ? (parsed.token as Record<string, unknown>)
        : parsed;
    const refreshToken = typeof rawToken.refresh_token === 'string' ? rawToken.refresh_token.trim() : '';
    if (!refreshToken) return null;

    const nowSec = Math.floor(Date.now() / 1000);
    let expirySec = 0;
    if (typeof rawToken.expiry_timestamp === 'number' && Number.isFinite(rawToken.expiry_timestamp) && rawToken.expiry_timestamp > 0) {
      expirySec = Math.floor(rawToken.expiry_timestamp);
    } else if (typeof rawToken.expiry === 'string' && rawToken.expiry) {
      const ms = Date.parse(rawToken.expiry);
      if (Number.isFinite(ms) && ms > 0) expirySec = Math.floor(ms / 1000);
    }

    const accessToken = typeof rawToken.access_token === 'string' ? rawToken.access_token : '';
    const idToken = typeof rawToken.id_token === 'string' && rawToken.id_token ? rawToken.id_token : null;
    const candidateEmail =
      (typeof parsed.id_token_email === 'string' && parsed.id_token_email.includes('@')
        ? parsed.id_token_email
        : null) ??
      (typeof rawToken.email === 'string' && rawToken.email.includes('@') ? rawToken.email : null) ??
      decodeJwtEmail(idToken);
    const email = candidateEmail ? candidateEmail.trim().toLowerCase() : null;

    return {
      email,
      token: {
        access_token: accessToken,
        token_type: typeof rawToken.token_type === 'string' && rawToken.token_type ? rawToken.token_type : 'Bearer',
        refresh_token: refreshToken,
        expiry_timestamp: expirySec,
        expires_in:
          typeof rawToken.expires_in === 'number' && Number.isFinite(rawToken.expires_in)
            ? rawToken.expires_in
            : expirySec > nowSec
              ? expirySec - nowSec
              : 0,
        email,
        project_id: typeof rawToken.project_id === 'string' && rawToken.project_id ? rawToken.project_id : null,
        is_gcp_tos: Boolean(rawToken.is_gcp_tos),
        id_token: idToken,
      },
    };
  } catch {
    return null;
  }
}

export function decodeKeychainOAuthToken(raw: string | null | undefined): {
  token: OAuthTokenData;
  email: string | null;
} | null {
  return parseOAuthJson(decodeKeychainOauthJson(raw));
}

/**
 * Build the official Go `oauth2.Token` JSON payload consumed by Antigravity's
 * macOS Keychain (`gemini/antigravity`) and standalone CLI auth files.
 *
 * RFC3339 `expiry` is mandatory: Go's `oauth2.Token.Valid()` treats a zero/missing
 * expiry as never-expiring and skips refresh until 401 forces logout.
 */
export function buildGoOAuthPayload(email: string, token: OAuthTokenData): string {
  const normalizedEmail = email.trim().toLowerCase();
  const expirySec = Number(token.expiry_timestamp);
  const validExpiry = Number.isFinite(expirySec) && expirySec > 0;
  const expiry = validExpiry ? new Date(expirySec * 1000).toISOString() : new Date(0).toISOString();
  const expiresIn = validExpiry
    ? Math.max(0, Math.floor(expirySec - Date.now() / 1000))
    : (token.expires_in ?? 0);
  const accessToken =
    token.access_token && token.access_token !== 'pending_refresh' ? token.access_token : '';

  return JSON.stringify({
    token: {
      access_token: accessToken,
      token_type: token.token_type || 'Bearer',
      refresh_token: token.refresh_token,
      expiry,
      expires_in: expiresIn,
      expiry_timestamp: validExpiry ? Math.floor(expirySec) : 0,
      email: normalizedEmail,
      ...(token.project_id ? { project_id: token.project_id } : {}),
      ...(token.is_gcp_tos !== undefined ? { is_gcp_tos: token.is_gcp_tos } : {}),
      ...(token.id_token ? { id_token: token.id_token } : {}),
    },
    ...(token.is_gcp_tos ? {} : { auth_method: 'consumer' }),
    id_token_email: normalizedEmail,
  });
}

export function encodeKeychainOAuthPayload(
  email: string,
  token: OAuthTokenData,
  encoding: 'go-keyring-base64' | 'raw' = process.platform === 'win32' ? 'raw' : 'go-keyring-base64',
): string {
  let payload = buildGoOAuthPayload(email, token);
  if (encoding === 'raw') {
    if (Buffer.byteLength(payload, 'utf8') > WINDOWS_CRED_MAX_BYTES) {
      payload = buildGoOAuthPayload(email, { ...token, id_token: null });
    }
    if (Buffer.byteLength(payload, 'utf8') > WINDOWS_CRED_MAX_BYTES) {
      payload = buildGoOAuthPayload(email, {
        ...token,
        id_token: null,
        access_token: '',
        expiry_timestamp: 0,
        expires_in: 0,
      });
    }
    return payload;
  }
  return `go-keyring-base64:${Buffer.from(payload, 'utf8').toString('base64')}`;
}

export function shouldPreferTokenCandidate(
  current: OAuthTokenData,
  candidate: OAuthTokenData,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  const hasValidAccess = (t: OAuthTokenData) =>
    Boolean(t.access_token && t.access_token !== 'pending_refresh');
  const getExp = (t: OAuthTokenData) =>
    Number.isFinite(t.expiry_timestamp) ? t.expiry_timestamp : 0;

  const curValid = hasValidAccess(current);
  const candValid = hasValidAccess(candidate);
  if (candValid !== curValid) return candValid;
  if (!candValid) return false;

  const curExp = getExp(current);
  const candExp = getExp(candidate);
  const curUnexpired = curExp > nowSec;
  const candUnexpired = candExp > nowSec;
  if (candUnexpired !== curUnexpired) return candUnexpired;
  return candExp > curExp;
}
