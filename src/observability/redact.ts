/**
 * Deep-clone redaction for structured logs and errors. Masks secret-like field
 * names, oauth2 URLs, large diff/prompt payloads, and long secret-like strings.
 */

const OAUTH2_PATTERN = /(oauth2:)[^@\s/]+(@)/g;
const SECRET_LIKE_STRING = /^[A-Za-z0-9+/=_-]{32,}$/;

function isSecretFieldName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/_/g, '');
  return (
    normalized === 'token' ||
    normalized === 'apikey' ||
    normalized === 'authorization' ||
    normalized.endsWith('token') ||
    normalized.endsWith('apikey')
  );
}

function isDiffOrPromptField(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'diff' || lower === 'prompt';
}

function maskContentSummary(fieldName: string, value: string): string {
  const bytes = Buffer.byteLength(value, 'utf8');
  const kind = fieldName.toLowerCase();
  return `<${kind} ${bytes} bytes>`;
}

function redactString(text: string): string {
  const maskedOauth = text.replace(OAUTH2_PATTERN, '$1***$2');
  if (SECRET_LIKE_STRING.test(maskedOauth)) {
    return '***';
  }
  return maskedOauth;
}

function redactValue(value: unknown, fieldName: string | undefined): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    if (fieldName !== undefined && isDiffOrPromptField(fieldName)) {
      return maskContentSummary(fieldName, value);
    }
    if (fieldName !== undefined && isSecretFieldName(fieldName)) {
      return '***';
    }
    return redactString(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, undefined));
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (isSecretFieldName(key)) {
        result[key] = '***';
      } else if (isDiffOrPromptField(key) && typeof child === 'string') {
        result[key] = maskContentSummary(key, child);
      } else {
        result[key] = redactValue(child, key);
      }
    }
    return result;
  }

  return value;
}

/** Deep-clone `value` and mask secrets, diffs, and prompts. */
export function redact(value: unknown): unknown {
  return redactValue(value, undefined);
}
