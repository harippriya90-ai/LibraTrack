// Sets bcrypt-hashed DEMO passwords and creates placeholder storage files.
// LOCAL DEMO ONLY. Change these passwords for any real deployment.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

const DEMO_USERS = [
  { username: 'admin',            password: 'Admin@2026' },
  { username: 'staff_chennai',    password: 'Chennai@2026' },
  { username: 'staff_vellore',    password: 'Vellore@2026' },
  { username: 'staff_coimbatore', password: 'Coimbatore@2026' },
];

const STORAGE = path.join(__dirname, '..', 'storage');
const PROOFS = path.join(STORAGE, 'proofs');
const EBOOKS = path.join(STORAGE, 'ebooks');

// 1x1 PNG used as a placeholder payment proof
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function samplePdf(title) {
  const content = `BT /F1 14 Tf 20 70 Td (${title}) Tj ET`;
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const o of objs) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += o;
  }
  const xrefPos = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += String(off).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'libratrack',
  });

  for (const u of DEMO_USERS) {
    const hash = await bcrypt.hash(u.password, 12);
    const [res] = await conn.execute(
      'UPDATE users SET password_hash = ? WHERE username = ?',
      [hash, u.username]
    );
    console.log(`Password set for ${u.username} (rows updated: ${res.affectedRows})`);
  }

  fs.mkdirSync(PROOFS, { recursive: true });
  fs.mkdirSync(EBOOKS, { recursive: true });

  for (const name of ['demo_proof_1.png', 'demo_proof_2.png']) {
    fs.writeFileSync(path.join(PROOFS, name), Buffer.from(PNG_BASE64, 'base64'));
    console.log(`Created storage/proofs/${name}`);
  }

  const ebooks = [
    ['demo_ebook_1.pdf', 'LibraTrack sample file - Think Python'],
    ['demo_ebook_2.pdf', 'LibraTrack sample file - Pride and Prejudice'],
    ['demo_ebook_3.pdf', 'LibraTrack sample file - Meditations'],
    ['demo_ebook_4.pdf', 'LibraTrack sample file - Staff Handbook'],
  ];
  for (const [file, title] of ebooks) {
    const buf = samplePdf(title);
    fs.writeFileSync(path.join(EBOOKS, file), buf);
    await conn.execute('UPDATE ebooks SET file_size_bytes = ? WHERE stored_file_name = ?', [buf.length, file]);
    console.log(`Created storage/ebooks/${file} (${buf.length} bytes)`);
  }

  await conn.end();
  console.log('Done.');
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});