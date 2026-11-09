// Exportaciones del reporte: CSV (como 2.1), Excel (xlsx 0.18.5) y PDF (jspdf 2.5.1),
// las dos librerías servidas por la propia app con SRI calculado al compilar.
import vendor from 'virtual:panol-vendor';
import { ACT } from '../../ui/actions.js';
import { act } from '../../ui/feedback.js';
import { saveFile, loadScript } from '../../ui/files.js';
import { gateUI } from '../tecnicos/view.js';
import { computeReport } from './view.js';
import { csvCell } from './csv.js';
import { fdt, mlabel, nowISO } from '../../state/period.js';

function repTables(R) {
  // Etapa 4: unidades, % limpio al final (el PDF lee las columnas por posición) y "Por línea".
  const tech = [['Técnico', 'Legajo', 'Plantilla', 'Especialidad', 'Asignadas', 'Buen estado', 'Para cambio', 'Faltantes', '% en condiciones', 'Controles', 'Esperados', 'Reposiciones', 'Recuperadas', '% limpio'], ...R.rows.map((r) => [r.name, r.legajo, r.shift, r.especialidad, r.total, r.bueno, r.cambio, r.faltante, r.pct == null ? '' : r.pct, r.ctl, r.expected, r.repos, r.recup, r.pctLimpio == null ? '' : r.pctLimpio])];
  const sh = [['Plantilla', 'Técnicos', 'Herramientas', 'Buen estado', 'Para cambio', 'Faltantes', '% en condiciones', 'Controles realizados', 'Controles pendientes', 'Reposiciones', '% limpio'], ...R.shifts.map((s) => [s.name, s.techs, s.total, s.bueno, s.cambio, s.faltante, s.pct == null ? '' : s.pct, s.ctl, s.pend, s.repos, s.pctLimpio == null ? '' : s.pctLimpio])];
  const lineas = [['Línea o sector', 'Faltantes', 'Para recambio'], ...R.lineas.map((l) => [l.name, l.faltante, l.cambio])];
  const evo = [['Mes', 'Para cambio', 'Faltantes', 'Controles', 'Reposiciones', 'Recuperadas'], ...R.evo.map((e) => [mlabel(e.y, e.m), e.cambio, e.faltante, e.ctl, e.repos, e.recup])];
  // Por herramienta, en el orden personalizado (etapa 3).
  const tools = [['Herramienta', 'Categoría', 'Asignadas', 'Buen estado', 'Para cambio', 'Faltantes', 'Sin controlar'], ...R.tools.map((x) => [x.name, x.category, x.total, x.bueno, x.cambio, x.faltante, x.pendiente])];
  return { tech, sh, evo, tools, lineas };
}
const fileBase = (R) => `reporte-herramientas-${R.f.ym}${R.f.w !== 'all' ? '-s' + R.f.w : ''}`;

// CSV como 2.1 (separador ;), con las fórmulas neutralizadas: ver csv.js.
ACT.exportCsv = () => {
  if (!gateUI('reports_export')) return; const R = computeReport(); const T = repTables(R);
  const block = (title, rows) => [csvCell(title), ...rows.map((r) => r.map(csvCell).join(';'))].join('\r\n');
  const csv = '﻿' + [block('Reporte de herramientas: ' + R.label, []), block('Por técnico', T.tech), block('Por plantilla', T.sh), block('Evolución mensual', T.evo), block('Por herramienta', T.tools), block('Por línea', T.lineas)].join('\r\n\r\n');
  saveFile(fileBase(R) + '.csv', csv);
};
ACT.exportXlsx = async () => {
  if (!gateUI('reports_export')) return;
  await act(async () => {
    await loadScript(vendor.xlsx, () => window.XLSX); const XLSX = window.XLSX; const R = computeReport(); const T = repTables(R); const wb = XLSX.utils.book_new();
    const add = (name, rows) => { const ws = XLSX.utils.aoa_to_sheet([[`Reporte de herramientas: ${R.label}`], [], ...rows]); ws['!cols'] = rows[0].map((_, i) => ({ wch: i === 0 ? 26 : 14 })); XLSX.utils.book_append_sheet(wb, ws, name); };
    add('Por técnico', T.tech); add('Por plantilla', T.sh); add('Evolución', T.evo); add('Por herramienta', T.tools); add('Por línea', T.lineas);
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }); await saveFile(fileBase(R) + '.xlsx', new Blob([buf]));
  });
};
ACT.exportPdf = async () => {
  if (!gateUI('reports_export')) return;
  await act(async () => {
    await loadScript(vendor.jspdf, () => window.jspdf); const R = computeReport(); const T = repTables(R);
    const doc = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' }); const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(); let y = 48;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.text('Pañol: reporte de herramientas', 40, y); y += 20; doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(90); doc.text(`${R.label}. Generado ${fdt(nowISO())}.`, 40, y); doc.setTextColor(0); y += 26;
    const table = (title, rows, widths) => {
      if (y > H - 90) { doc.addPage(); y = 48; } doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.text(title, 40, y); y += 14; doc.setFontSize(9);
      const tw = W - 80; const ws = widths.map((w) => w * tw / widths.reduce((a, b) => a + b, 0));
      rows.forEach((r, ri) => { if (y > H - 40) { doc.addPage(); y = 48; } if (ri === 0) { doc.setFillColor(236, 239, 237); doc.rect(40, y - 10, tw, 16, 'F'); doc.setFont('helvetica', 'bold'); } else doc.setFont('helvetica', 'normal'); let x = 40; r.forEach((c, ci) => { const s = doc.splitTextToSize(String(c ?? ''), ws[ci] - 6)[0] || ''; doc.text(s, ci === 0 ? x + 3 : x + ws[ci] - 3, y, { align: ci === 0 ? 'left' : 'right' }); x += ws[ci]; }); y += 16; doc.setDrawColor(225); doc.line(40, y - 11, 40 + tw, y - 11); }); y += 18;
    };
    table('Por técnico', T.tech.map((r) => [r[0], r[2], r[4], r[5], r[6], r[7], r[8] === '' ? '—' : r[8] + '%', `${r[9]}/${r[10]}`, r[11], r[12]]).map((r, i) => (i === 0 ? ['Técnico', 'Plantilla', 'Asignadas', 'Bien', 'Cambio', 'Faltan', '% cond.', 'Controles', 'Reposic.', 'Recup.'] : r)), [3, 2, 1, 1, 1, 1, 1, 1, 1, 1]);
    table('Por plantilla', T.sh.map((r, i) => (i === 0 ? ['Plantilla', 'Técnicos', 'Herramientas', 'Bien', 'Cambio', 'Faltan', '% cond.', 'Controles', 'Pendientes', 'Reposic.'] : [r[0], r[1], r[2], r[3], r[4], r[5], r[6] === '' ? '—' : r[6] + '%', r[7], r[8], r[9]])), [3, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    table('Evolución mensual', T.evo, [3, 1, 1, 1, 1, 1]);
    table('Por herramienta', T.tools, [3, 2, 1, 1, 1, 1, 1]);
    if (T.lineas.length > 1) table('Faltantes y recambios por línea', T.lineas, [3, 1, 1]);
    await saveFile(fileBase(R) + '.pdf', new Blob([doc.output('arraybuffer')]));
  });
};
