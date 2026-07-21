/**
 * Minimal big-endian NBT reader, enough to pull ExtraAttributes out of an
 * auction's `item_bytes`. No dependency — the format is small and we only ever
 * read, never write.
 *
 * The backend should use `prismarine-nbt` instead; this exists so the Live view
 * can demonstrate upgrade detection against real auctions in the browser.
 */

export type NbtValue =
  | number
  | bigint
  | string
  | NbtValue[]
  | { [key: string]: NbtValue }
  | Uint8Array;

const TAG_END = 0;

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  // Detach a plain ArrayBuffer view: a Uint8Array may be backed by a
  // SharedArrayBuffer, which BlobPart does not accept.
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

class Reader {
  private pos = 0;
  private view: DataView;
  private decoder = new TextDecoder('utf-8');

  constructor(private buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  byte(): number {
    return this.view.getInt8(this.pos++);
  }
  ubyte(): number {
    return this.view.getUint8(this.pos++);
  }
  short(): number {
    const v = this.view.getInt16(this.pos);
    this.pos += 2;
    return v;
  }
  ushort(): number {
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }
  int(): number {
    const v = this.view.getInt32(this.pos);
    this.pos += 4;
    return v;
  }
  long(): bigint {
    const v = this.view.getBigInt64(this.pos);
    this.pos += 8;
    return v;
  }
  float(): number {
    const v = this.view.getFloat32(this.pos);
    this.pos += 4;
    return v;
  }
  double(): number {
    const v = this.view.getFloat64(this.pos);
    this.pos += 8;
    return v;
  }
  string(): string {
    const len = this.ushort();
    const s = this.decoder.decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }
  bytes(n: number): Uint8Array {
    const s = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }

  payload(type: number): NbtValue {
    switch (type) {
      case 1:
        return this.byte();
      case 2:
        return this.short();
      case 3:
        return this.int();
      case 4:
        return this.long();
      case 5:
        return this.float();
      case 6:
        return this.double();
      case 7:
        return this.bytes(this.int());
      case 8:
        return this.string();
      case 9: {
        const itemType = this.ubyte();
        const len = this.int();
        const out: NbtValue[] = [];
        for (let i = 0; i < len; i++) out.push(itemType === TAG_END ? 0 : this.payload(itemType));
        return out;
      }
      case 10: {
        const out: Record<string, NbtValue> = {};
        for (;;) {
          const t = this.ubyte();
          if (t === TAG_END) break;
          const name = this.string();
          out[name] = this.payload(t);
        }
        return out;
      }
      case 11: {
        const len = this.int();
        const out: number[] = [];
        for (let i = 0; i < len; i++) out.push(this.int());
        return out;
      }
      case 12: {
        const len = this.int();
        const out: bigint[] = [];
        for (let i = 0; i < len; i++) out.push(this.long());
        return out as unknown as NbtValue;
      }
      default:
        throw new Error(`Unknown NBT tag type ${type}`);
    }
  }

  root(): Record<string, NbtValue> {
    const type = this.ubyte();
    if (type !== 10) throw new Error('NBT root is not a compound');
    this.string(); // root name, always empty in practice
    return this.payload(10) as Record<string, NbtValue>;
  }
}

export function parseNbt(bytes: Uint8Array): Record<string, NbtValue> {
  return new Reader(bytes).root();
}

/**
 * The item's craft time, from `ExtraAttributes.timestamp`.
 *
 * This field is a TAG_Long and shows up in three different shapes depending on
 * the parser and the item's age — get it wrong and every historical price
 * lookup is anchored to the wrong date:
 *
 *  - bigint            — what this reader produces (getBigInt64)
 *  - [high, low] ints  — what prismarine-nbt and several other libraries emit
 *                        for a long; naive code passes the ARRAY to new Date()
 *  - string            — legacy items, e.g. "7/17/26 4:30 PM"
 *
 * Returns null rather than guessing, so callers can set `ageEstimated`.
 */
export function readCraftTimestamp(ea: Record<string, NbtValue>): Date | null {
  const t = ea.timestamp;

  if (typeof t === 'bigint') return new Date(Number(t));
  if (typeof t === 'number') return new Date(t);

  if (Array.isArray(t) && t.length === 2 && typeof t[0] === 'number' && typeof t[1] === 'number') {
    // Two signed 32-bit halves of one 64-bit long: high * 2^32 + unsigned(low).
    const ms = t[0] * 2 ** 32 + (t[1] >>> 0);
    return Number.isFinite(ms) ? new Date(ms) : null;
  }

  if (typeof t === 'string') {
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  return null;
}

/**
 * Full path from an auction's `item_bytes` to the item's ExtraAttributes.
 * Returns null when the blob has no attributes (vanilla items, empty slots).
 */
export async function readExtraAttributes(itemBytes: string): Promise<Record<string, NbtValue> | null> {
  const raw = await gunzip(base64ToBytes(itemBytes));
  const root = parseNbt(raw);
  const list = root.i as NbtValue[] | undefined;
  if (!Array.isArray(list) || list.length === 0) return null;

  const first = list[0] as Record<string, NbtValue>;
  const tag = first?.tag as Record<string, NbtValue> | undefined;
  const ea = tag?.ExtraAttributes as Record<string, NbtValue> | undefined;
  return ea ?? null;
}
