// ZIP armados a mano para probar el lector contra archivos hostiles (índice cortado, tamaños
// declarados falsos, bombas de compresión, cifrado, ZIP64, XML sin cerrar). Datos inventados.
import zlib from 'node:zlib';

// entries: [{ name, data (string | Buffer), method?: 0 | 8, flags?, usize?, csize?, raw? }]
// (usize/csize/raw reemplazan lo calculado). eocd: { count?, size?, offset? } reemplaza el final.
export function buildZip(entries, { eocd = {} } = {}) {
  const locals = [];
  const cens = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''), 'utf8');
    const method = e.method ?? 8;
    const comp = e.raw ?? (method === 8 ? zlib.deflateRawSync(data) : data);
    const name = Buffer.from(e.name, 'utf8');
    const crc = zlib.crc32(data);
    const csize = e.csize ?? comp.length;
    const usize = e.usize ?? data.length;
    const flags = (e.flags ?? 0) | 0x800;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(csize >>> 0, 18);
    lh.writeUInt32LE(usize >>> 0, 22);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(csize >>> 0, 20);
    ch.writeUInt32LE(usize >>> 0, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(e.local ?? offset, 42);
    locals.push(lh, name, comp);
    cens.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cen = Buffer.concat(cens);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(eocd.count ?? entries.length, 8);
  end.writeUInt16LE(eocd.count ?? entries.length, 10);
  end.writeUInt32LE((eocd.size ?? cen.length) >>> 0, 12);
  end.writeUInt32LE((eocd.offset ?? offset) >>> 0, 16);
  return Buffer.concat([...locals, cen, end]);
}

// Partes mínimas de un libro con una hoja: workbook.xml, sus relaciones, la hoja y (opcional)
// sharedStrings.xml. `over` reemplaza o agrega opciones por nombre de parte.
export function xlsxEntries({ sheetXml, sst = null, workbookXml = null, over = {} } = {}) {
  const parts = [
    { name: 'xl/workbook.xml', data: workbookXml ?? '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Hoja1" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml ?? '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>' },
  ];
  if (sst != null) parts.push({ name: 'xl/sharedStrings.xml', data: sst });
  return parts.map((p) => ({ ...p, ...(over[p.name] || {}) }));
}

export const xlsxZip = (opts = {}, zipOpts = {}) => buildZip(xlsxEntries(opts), zipOpts);
