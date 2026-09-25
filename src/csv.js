/* CSV متوافق مع Excel (عربي): BOM لعرض العربي صح، ودعم الفاصلة أو الفاصلة المنقوطة */

const needsQuote = /[",;\n\r]/;
const cell = (v) => { const s = v == null ? '' : String(v); return needsQuote.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

export function toCsv(header, rows) {
  return '﻿' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function parseCsv(text) {
  text = String(text).replace(/^﻿/, '');
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const delim = firstLine.includes(';') && !firstLine.includes(',') ? ';' : firstLine.includes('\t') && !firstLine.includes(',') ? '\t' : ',';
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}
