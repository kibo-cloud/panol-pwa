// Lector mínimo de archivos ZIP (el contenedor de .xlsx y .xlsm), puro y sin dependencias.
// Solo lee el directorio central y descomprime las entradas que se piden (sin cifrado, sin
// ZIP64, métodos "stored" y "deflate"). Nunca toca `vbaProject.bin`: las macros no se leen ni
// se ejecutan. Límites contra archivos armados para agotar memoria (bombas de compresión).
import zlib from 'node:zlib';

export class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipError';
  }
}

// Cada parte XML descomprimida, hasta 16 MB (E9.V1); el total leído, hasta 128 MB.
export const ZIP_LIMITS = Object.freeze({ entries: 5000, entryBytes: 16 * 1024 * 1024, totalBytes: 128 * 1024 * 1024 });

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

// Busca el registro de fin del directorio central (puede tener un comentario de hasta 64 KB).
function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  return -1;
}

// Devuelve { names, read(name) -> Buffer | null }.
export function openZip(buf, limits = ZIP_LIMITS) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new ZipError('El archivo está vacío o no es un libro de Excel.');
  if (buf.readUInt32LE(0) !== SIG_LOC) throw new ZipError('El archivo no es un libro de Excel (.xlsx o .xlsm).');
  const e = findEocd(buf);
  if (e < 0) throw new ZipError('El archivo está dañado: no se encontró el índice del libro.');
  const count = buf.readUInt16LE(e + 10);
  const size = buf.readUInt32LE(e + 12);
  const offset = buf.readUInt32LE(e + 16);
  if (count === 0xffff || offset === 0xffffffff || size === 0xffffffff) throw new ZipError('El formato del archivo no es compatible (ZIP64).');
  if (count > limits.entries) throw new ZipError('El archivo tiene demasiadas partes para ser un libro de Excel.');
  if (offset + size > buf.length) throw new ZipError('El archivo está dañado: el índice apunta fuera del archivo.');
  const entries = new Map();
  let p = offset;
  const cenEnd = offset + size;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cenEnd || buf.readUInt32LE(p) !== SIG_CEN) throw new ZipError('El archivo está dañado: índice incompleto.');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    if (p + 46 + nlen + xlen + clen > cenEnd) throw new ZipError('El archivo está dañado: índice incompleto.');
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) throw new ZipError('El formato del archivo no es compatible (ZIP64).');
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nlen);
    if (!entries.has(name)) entries.set(name, { flags, method, csize, usize, local });
    p += 46 + nlen + xlen + clen;
  }
  let total = 0;
  function read(name) {
    const en = entries.get(name);
    if (!en) return null;
    if (en.flags & 0x1) throw new ZipError('El archivo está protegido con contraseña: guardalo sin contraseña y probá de nuevo.');
    if (en.usize > limits.entryBytes) throw new ZipError('Una hoja del libro es demasiado grande para importarla.');
    total += en.usize;
    if (total > limits.totalBytes) throw new ZipError('El libro es demasiado grande para importarlo.');
    const lp = en.local;
    if (lp + 30 > buf.length || buf.readUInt32LE(lp) !== SIG_LOC) throw new ZipError('El archivo está dañado: una parte no se puede leer.');
    const start = lp + 30 + buf.readUInt16LE(lp + 26) + buf.readUInt16LE(lp + 28);
    if (start + en.csize > buf.length) throw new ZipError('El archivo está dañado: una parte está cortada.');
    const data = buf.subarray(start, start + en.csize);
    let out;
    if (en.method === 0) out = Buffer.from(data);
    else if (en.method === 8) {
      try {
        out = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, en.usize) });
      } catch {
        throw new ZipError('El archivo está dañado: una parte no se puede descomprimir.');
      }
    } else throw new ZipError('El archivo usa una compresión que no se puede leer.');
    if (out.length !== en.usize) throw new ZipError('El archivo está dañado: el tamaño de una parte no coincide.');
    return out;
  }
  return { names: [...entries.keys()], read };
}
