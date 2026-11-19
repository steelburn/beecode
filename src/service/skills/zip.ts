import { inflateRawSync } from 'node:zlib';

/** One file inside a ZIP archive, decompressed. */
export interface ZipEntry {
  /** Path as stored in the archive, forward slashes, no leading `./`. */
  name: string;
  data: Buffer;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_COMMENT = 0xffff;

/**
 * Read a ZIP archive without a dependency.
 *
 * Only what a skill archive needs: the central directory for the file list (so data
 * descriptors from streaming writers do not matter), then stored (0) and deflate (8)
 * entries through `node:zlib`. Directory entries are dropped, and anything that would
 * escape the archive root is refused by the caller when it writes.
 */
export function readZip(buffer: Buffer): ZipEntry[] {
  if (buffer.length < 22) throw new Error('not a zip archive (too small)');
  let eocd = -1;
  const earliest = Math.max(0, buffer.length - 22 - MAX_COMMENT);
  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive (no central directory)');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL) {
      throw new Error('corrupt zip archive (bad central directory)');
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/') || !name) continue;
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL) {
      throw new Error(`corrupt zip archive (bad entry header for ${name})`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(start, start + compressedSize);
    if (method === 0) entries.push({ name, data: Buffer.from(raw) });
    else if (method === 8) entries.push({ name, data: inflateRawSync(raw) });
    else throw new Error(`unsupported zip compression method ${method} (${name})`);
  }
  return entries;
}
