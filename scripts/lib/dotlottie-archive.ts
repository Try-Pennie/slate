/**
 * Reading and writing a `.lottie` file, which is a ZIP archive (#2560).
 *
 * A dotLottie holds `manifest.json`, the animation JSON under `a/`, and the
 * image assets under `i/`. Slate needs to open one (to keep half of it) and to
 * write one back, and node ships neither a zip reader nor a zip writer, so both
 * live here rather than pulling a dependency in for two callers.
 *
 * Only what a dotLottie actually contains is supported: stored and deflated
 * entries, no encryption, no zip64, no data descriptors. Anything else THROWS
 * rather than being skipped, because an entry silently dropped from an archive
 * is a frame that silently stops drawing.
 */
import zlib from "node:zlib";

export type ArchiveEntry = {
  /** The path inside the archive, e.g. `i/imgSeq_232.png`. */
  name: string;
  /** The uncompressed bytes. */
  data: Buffer;
};

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

/** Every entry in a `.lottie`, in the order the central directory lists them. */
export function readArchive(zip: Buffer): ArchiveEntry[] {
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive: no end of central directory record");

  const count = zip.readUInt16LE(eocd + 10);
  let off = zip.readUInt32LE(eocd + 16);
  const out: ArchiveEntry[] = [];

  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(off) !== CENTRAL_SIG) throw new Error(`bad central directory at ${off}`);
    const method = zip.readUInt16LE(off + 10);
    const compressedSize = zip.readUInt32LE(off + 20);
    const nameLen = zip.readUInt16LE(off + 28);
    const extraLen = zip.readUInt16LE(off + 30);
    const commentLen = zip.readUInt16LE(off + 32);
    const localOff = zip.readUInt32LE(off + 42);
    const name = zip.toString("utf8", off + 46, off + 46 + nameLen);

    if (zip.readUInt32LE(localOff) !== LOCAL_SIG) throw new Error(`bad local header for ${name}`);
    const localNameLen = zip.readUInt16LE(localOff + 26);
    const localExtraLen = zip.readUInt16LE(localOff + 28);
    const start = localOff + 30 + localNameLen + localExtraLen;
    const raw = zip.subarray(start, start + compressedSize);

    if (method === 0) out.push({ name, data: Buffer.from(raw) });
    else if (method === 8) out.push({ name, data: zlib.inflateRawSync(raw) });
    else throw new Error(`${name}: unsupported compression method ${method}`);

    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** CRC-32, which every zip entry carries and no node module exposes. */
function crc32(buf: Buffer): number {
  let table = crcTable;
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    crcTable = table;
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff]! ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}
let crcTable: Int32Array | null = null;

/**
 * A `.lottie` holding exactly these entries, in this order.
 *
 * Every timestamp is fixed rather than taken from the clock, so rebuilding from
 * the same source gives byte-identical output: a committed asset whose bytes
 * change on every rebuild can never be checked against its own build step.
 */
export function writeArchive(entries: ArchiveEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const deflated = zlib.deflateRawSync(entry.data, { level: 9 });
    // PNGs are already deflated, so storing them is routinely smaller than
    // deflating them a second time. Take whichever is.
    const stored = deflated.length >= entry.data.length;
    const body = stored ? entry.data : deflated;
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(33, 12); // mod date: 1st Jan 1996, a fixed stamp
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 30); // extra + comment lengths
    central.writeUInt32LE(0, 34); // disk number + internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }

  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, directory, eocd]);
}
