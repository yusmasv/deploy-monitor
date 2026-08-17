import { deflateRawSync, crc32 } from "node:zlib";

export interface Entry {
  name: string;
  data?: Buffer;
  /**
   * Override untuk field "uncompressed size" di local & central header.
   * Kalau diisi dan berbeda dari `data.length` yang sesungguhnya, ini
   * memalsukan header persis seperti zip-bomb yang berbohong soal ukuran
   * aslinya — dipakai test untuk membuktikan kode kita tidak cuma percaya
   * begitu saja pada angka yang diumumkan header. Default: `data.length`
   * asli (header jujur, seperti zip pada umumnya).
   */
  declaredSize?: number;
}

/** Membangun arsip ZIP minimal tapi valid. Nama entry dipakai APA ADANYA
 *  supaya test bisa menyuntikkan '../' dan path absolut. */
export function makeZip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const raw = e.data ?? Buffer.alloc(0);
    const comp = deflateRawSync(raw);
    const crc = crc32(raw);
    const declaredSize = e.declaredSize ?? raw.length;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8);              // deflate
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(declaredSize, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(declaredSize, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += 30 + name.length + comp.length;
  }

  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, central, eocd]);
}
