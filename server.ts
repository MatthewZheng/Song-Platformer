import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer as createViteServer } from 'vite';

const execFileAsync = promisify(execFile);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.get('/api/songs/status', (_req, res) => {
    res.json({ available: true });
  });

  app.post(
    '/api/songs/upload',
    express.raw({ type: '*/*', limit: '60mb' }),
    async (req, res) => {
      try {
        const rawName = String(req.query.filename || 'uploaded.mp3');
        const safeBase =
          path
            .basename(rawName, path.extname(rawName))
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'custom';
        const songsDir = path.resolve(process.cwd(), 'songs');
        fs.mkdirSync(songsDir, { recursive: true });
        const destPath = path.join(songsDir, `${safeBase}.mp3`);
        const bodyBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
        if (bodyBuf.length < 1024) {
          res.status(400).json({ error: 'Invalid or empty MP3 upload' });
          return;
        }
        fs.writeFileSync(destPath, bodyBuf);
        await execFileAsync('npx', ['tsx', 'scripts/analyze.ts', destPath], {
          cwd: process.cwd(),
          maxBuffer: 1024 * 1024 * 20,
        });
        res.json({ ok: true, id: safeBase });
      } catch (err) {
        console.error('[server] Song upload/analyze error:', err);
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Song Arcade server listening on http://localhost:${PORT}`);
  });
}

void startServer();
