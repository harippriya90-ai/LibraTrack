const express = require('express');
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const { authenticateMember } = require('../middleware/auth');
const { getMemberAccess } = require('../services/memberAccess');

const router = express.Router();

// Private folder, outside anything served as static files.
const EBOOK_DIR = path.resolve(__dirname, '..', '..', 'storage', 'ebooks');
const MIME = { pdf: 'application/pdf', epub: 'application/epub+zip' };

async function logAccess(ebookId, memberId, action, granted, reason) {
  try {
    await pool.execute(
      `INSERT INTO ebook_access (ebook_id, member_id, user_id, action, granted, deny_reason)
       VALUES (?, ?, NULL, ?, ?, ?)`,
      [ebookId, memberId, action, granted ? 1 : 0, reason ? reason.slice(0, 100) : null]
    );
  } catch (err) {
    console.error('Ebook access log failed:', err.message);
  }
}

function downloadName(title, format) {
  const base = String(title).replace(/[^A-Za-z0-9 _.-]/g, '').trim().replace(/\s+/g, '_').slice(0, 80);
  return `${base || 'ebook'}.${format}`;
}

function serve(action) {
  return async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: 'Ebook ID must be a positive whole number' });
    }
    const memberId = req.member.member_id;

    try {
      // Staff-only and inactive ebooks do not exist as far as members are concerned.
      const [rows] = await pool.execute(
        `SELECT ebook_id, title, file_format, stored_file_name, access_policy
           FROM ebooks
          WHERE ebook_id = ? AND is_active = 1 AND access_policy <> 'staff_only'`,
        [id]
      );
      const e = rows[0];
      if (!e) return res.status(404).json({ error: 'Ebook not found' });

      const access = await getMemberAccess(memberId);
      if (!access.eligible) {
        await logAccess(e.ebook_id, memberId, action, false, access.reason);
        return res.status(403).json({ error: access.reason });
      }

      if (action === 'download' && e.access_policy !== 'download_allowed') {
        const msg = 'This ebook can be read online but not downloaded.';
        await logAccess(e.ebook_id, memberId, action, false, msg);
        return res.status(403).json({ error: msg });
      }

      // The path comes only from the database's stored name, and must stay inside EBOOK_DIR.
      const filePath = path.resolve(EBOOK_DIR, path.basename(e.stored_file_name));
      if (path.dirname(filePath) !== EBOOK_DIR) {
        console.error('Ebook path escaped storage folder:', e.stored_file_name);
        return res.status(500).json({ error: 'Something went wrong. Please try again.' });
      }

      let stat;
      try {
        stat = await fs.promises.stat(filePath);
      } catch (err) {
        console.error('Ebook file missing:', e.stored_file_name);
        await logAccess(e.ebook_id, memberId, action, false, 'File unavailable');
        return res.status(404).json({ error: 'This file is currently unavailable. Please contact the library.' });
      }

      const stream = fs.createReadStream(filePath);
      stream.on('error', (err) => {
        console.error('Ebook stream error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Please try again.' });
        else res.destroy();
      });
      stream.once('open', async () => {
        await logAccess(e.ebook_id, memberId, action, true, null);
        res.set({
          'Content-Type': MIME[e.file_format] || 'application/octet-stream',
          'Content-Length': stat.size,
          'Content-Disposition': `${action === 'download' ? 'attachment' : 'inline'}; filename="${downloadName(e.title, e.file_format)}"`,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, no-store',
        });
        stream.pipe(res);
      });
    } catch (err) {
      console.error('Ebook file error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  };
}

router.get('/ebooks/:id/read', authenticateMember, serve('read'));
router.get('/ebooks/:id/download', authenticateMember, serve('download'));

module.exports = router;