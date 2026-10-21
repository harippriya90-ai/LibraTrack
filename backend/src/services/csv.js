// CSV building with spreadsheet-formula protection.
function csvCell(value, isText) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  // Text typed by users could start with = + - @ and be run as a formula by a spreadsheet.
  if (isText && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

// columns: [{ key, header, text? }]. The leading BOM lets Excel read UTF-8 correctly.
function toCsv(columns, rows) {
  const lines = [columns.map((c) => csvCell(c.header, true)).join(',')];
  for (const r of rows) {
    lines.push(columns.map((c) => csvCell(r[c.key], !!c.text)).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

module.exports = { toCsv };