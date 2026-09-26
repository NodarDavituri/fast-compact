/**
 * Masks credential-shaped strings before any text leaves the machine. Pattern
 * based: a hooks module cannot enumerate the environment, so known values
 * cannot be looked for. Applied per string value, never over serialised JSON,
 * where a mask could swallow an escape.
 */
import { wellFormed } from './text.js';

const PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(Bearer\s+|Basic\s+)[A-Za-z0-9._~+/=-]{16,}/g,
  /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/gi,
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY)[A-Z0-9_]*\s*[=:]\s*["']?)[^\s"']{6,}/gi,
];

export function redact(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (...args: unknown[]) => {
      count++;
      const keep = typeof args[1] === 'string' ? args[1] : '';
      return `${keep}[REDACTED]`;
    });
  }
  return { text: out, count };
}

/**
 * JSON for a request body: every string value masked and made well-formed (a
 * cut can split a surrogate pair, and the endpoints reject the lone half).
 */
export function requestJson(value: unknown): { body: string; redacted: number } {
  let redacted = 0;
  const body = JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v !== 'string') return v;
    const r = redact(wellFormed(v));
    redacted += r.count;
    return r.text;
  });
  return { body, redacted };
}
