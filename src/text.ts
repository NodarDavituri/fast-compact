/** Cutting text, and telling what the host wrote from what a person wrote. */

/** A cut this plugin made, as it reads in the transcript; never cut twice. */
export const CUT_MARK = '[fast-compact: cut ';

const HOST_PREFIXES = [
  '<system-reminder>',
  '<task-notification>',
  '<local-command-',
  '<command-name>',
  '<command-message>',
  'Caveat: The messages below were generated',
];

/** Text the host wrote into a user message: reminders, command echoes, notifications. */
export function isHostText(text: string): boolean {
  const start = text.trimStart();
  return HOST_PREFIXES.some((prefix) => start.startsWith(prefix));
}

/** A marker this plugin wrote, whole: text that merely quotes its opening does not count. */
const CUT_RE =
  /\n\[fast-compact: cut \d+ chars (?:from the middle of [^\]\n]*?|of this notice); the full text is in [^\]\n]+\]/;

export function wasCut(text: string): boolean {
  return CUT_RE.test(text);
}

/**
 * Replaces an unpaired surrogate half with U+FFFD (what `toWellFormed` does,
 * which the hooks environment may not have).
 */
export function wellFormed(text: string): string {
  let out = '';
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0xd800 || c > 0xdfff) continue;
    const next = text.charCodeAt(i + 1);
    if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      i++;
      continue;
    }
    out += `${text.slice(from, i)}\ufffd`;
    from = i + 1;
  }
  return from === 0 ? text : out + text.slice(from);
}

/** Slices by UTF-16 index without leaving half a surrogate pair at either edge. */
function safeSlice(text: string, start: number, end?: number): string {
  return wellFormed(text.slice(start, end));
}

/** The start and end of `text` around a marker naming where the whole of it is. */
export function cutMiddle(text: string, keep: number, where: string, what = 'this'): string {
  const head = Math.floor((keep * 2) / 3);
  const tail = keep - head;
  const cut = text.length - head - tail;
  return `${safeSlice(text, 0, head)}\n${CUT_MARK}${cut} chars from the middle of ${what}; the full text is in ${where} — read it before relying on what was cut]\n${safeSlice(text, text.length - tail)}`;
}

/** The start of `text` and a marker naming where the whole of it is. */
export function cutEnd(text: string, keep: number, where: string): string {
  return `${safeSlice(text, 0, keep)}\n${CUT_MARK}${text.length - keep} chars of this notice; the full text is in ${where}]`;
}

/** The first `limit` characters, with an ellipsis when cut. */
export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${safeSlice(text, 0, Math.max(0, limit - 1))}…`;
}

/** Whitespace collapsed, then the start and end of a long text. */
export function sample(text: string, head = 200, tail = 100): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= head + tail + 20) return flat;
  return `${safeSlice(flat, 0, head)} […] ${safeSlice(flat, flat.length - tail)}`;
}
