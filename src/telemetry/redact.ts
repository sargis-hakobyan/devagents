const secretKey = /(?:key|token|secret|password|authorization|cookie|credential)/i;
export function redact(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === 'string') {
    let result = value.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g, '[REDACTED]')
      .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
      .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
    for (const secret of secrets.filter(s => s.length > 3).sort((a, b) => b.length - a.length)) result = result.split(secret).join('[REDACTED]');
    return result;
  }
  if (Array.isArray(value)) return value.map(v => redact(v, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, secretKey.test(k) ? '[REDACTED]' : redact(v, secrets)]));
  return value;
}
export function environmentSecrets(env = process.env): string[] {
  return Object.entries(env).filter(([k, v]) => secretKey.test(k) && v).map(([, v]) => v!);
}
export function log(event: string, data: unknown = {}): void {
  process.stderr.write(`${JSON.stringify(redact({ timestamp: new Date().toISOString(), event, data }, environmentSecrets()))}\n`);
}
