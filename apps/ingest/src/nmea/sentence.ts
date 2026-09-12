/**
 * NMEA 0183 framing: split a line into talker, sentence type and fields, and
 * verify the checksum. No interpretation happens here.
 *
 * Accepts both `$` (talker) and `!` (encapsulated, i.e. AIS) sentences, and
 * strips an optional NMEA 4.10 TAG block (`\s:src,c:ts*hh\`) if present.
 */
export interface RawSentence {
  /** The sentence exactly as received, without line terminator or TAG block. */
  raw: string;
  /** '$' or '!'. */
  prefix: '$' | '!';
  /** Two-letter talker id, e.g. "GP", "AI", "II". Proprietary "P" sentences have talker "P". */
  talker: string;
  /** Sentence type, e.g. "RMC", "VDM". */
  type: string;
  /** Comma-separated fields after the address, excluding the checksum. */
  fields: string[];
  /** Whether a checksum was present and matched. */
  checksumOk: boolean;
  /** Whether the sentence carried a checksum at all. */
  hasChecksum: boolean;
  /** Parsed TAG block fields, if any. */
  tag?: Record<string, string>;
}

export type SplitResult =
  | { ok: true; sentence: RawSentence }
  | { ok: false; reason: 'not-nmea' | 'malformed' | 'bad-checksum'; raw: string };

/** XOR checksum over the body between `$`/`!` and `*`, as two uppercase hex digits. */
export function computeChecksum(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum ^= body.charCodeAt(i);
  return sum.toString(16).toUpperCase().padStart(2, '0');
}

export function splitSentence(line: string): SplitResult {
  let s = line.trim();
  let tag: Record<string, string> | undefined;

  // TAG block: \s:1234,c:1234567890*hh\$GPRMC,...
  if (s.startsWith('\\')) {
    const end = s.indexOf('\\', 1);
    if (end === -1) return { ok: false, reason: 'malformed', raw: line };
    const block = s.slice(1, end);
    const star = block.indexOf('*');
    const body = star === -1 ? block : block.slice(0, star);
    tag = {};
    for (const part of body.split(',')) {
      const [k, v] = part.split(':');
      if (k && v !== undefined) tag[k] = v;
    }
    s = s.slice(end + 1);
  }

  const prefix = s[0];
  if (prefix !== '$' && prefix !== '!') return { ok: false, reason: 'not-nmea', raw: line };

  const star = s.lastIndexOf('*');
  let body: string;
  let hasChecksum = false;
  let checksumOk = false;
  if (star !== -1 && star === s.length - 3) {
    body = s.slice(1, star);
    hasChecksum = true;
    checksumOk = computeChecksum(body) === s.slice(star + 1).toUpperCase();
    if (!checksumOk) return { ok: false, reason: 'bad-checksum', raw: line };
  } else if (star !== -1) {
    return { ok: false, reason: 'malformed', raw: line };
  } else {
    body = s.slice(1);
  }

  const fields = body.split(',');
  const address = fields.shift() ?? '';
  if (address.length < 3) return { ok: false, reason: 'malformed', raw: line };

  // Proprietary sentences: $PXXX... talker "P", type is the rest.
  const talker = address.startsWith('P') ? 'P' : address.slice(0, 2);
  const type = address.startsWith('P') ? address.slice(1) : address.slice(2);
  if (!/^[A-Z0-9]+$/.test(type)) return { ok: false, reason: 'malformed', raw: line };

  const sentence: RawSentence = { raw: s, prefix, talker, type, fields, checksumOk, hasChecksum };
  if (tag) sentence.tag = tag;
  return { ok: true, sentence };
}

/**
 * Build a sentence with a checksum. `address` includes talker and type,
 * e.g. "GPRMC". Fields are joined verbatim; callers format numbers.
 */
export function buildSentence(
  address: string,
  fields: (string | number)[],
  prefix: '$' | '!' = '$',
): string {
  const body = [address, ...fields.map(String)].join(',');
  return `${prefix}${body}*${computeChecksum(body)}`;
}

/**
 * Incremental line splitter for a byte stream. Handles CRLF and LF, and
 * caps the buffer so a source that never sends a newline cannot grow memory.
 */
export class LineSplitter {
  private buffer = '';
  constructor(private readonly maxBuffer = 16 * 1024) {}

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length > 0) lines.push(line);
    }
    if (this.buffer.length > this.maxBuffer) this.buffer = '';
    return lines;
  }

  reset(): void {
    this.buffer = '';
  }
}
