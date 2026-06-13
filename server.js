const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const TMDB_ORIGIN = 'https://api.themoviedb.org/3';
const TMDB_KEY = process.env.TMDB_API_KEY || process.env.TMDB_KEY || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJSON(res, status, payload) {
  send(res, status, JSON.stringify(payload), {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
}

async function proxyTMDB(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJSON(res, 405, { error: 'Method not allowed' });
  }

  if (!TMDB_KEY) {
    return sendJSON(res, 503, {
      error: 'TMDB_API_KEY is not configured on the server',
    });
  }

  const upstreamPath = url.pathname.replace(/^\/api\/tmdb/, '') || '/';
  const upstream = new URL(TMDB_ORIGIN + upstreamPath);

  for (const [key, value] of url.searchParams) {
    if (key.toLowerCase() !== 'api_key') upstream.searchParams.append(key, value);
  }

  const headers = { accept: 'application/json' };
  if (TMDB_KEY.startsWith('eyJ')) {
    headers.authorization = `Bearer ${TMDB_KEY}`;
  } else {
    upstream.searchParams.set('api_key', TMDB_KEY);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const upstreamResponse = await fetch(upstream, {
      method: req.method,
      headers,
      signal: controller.signal,
    });
    const body = req.method === 'HEAD' ? null : Buffer.from(await upstreamResponse.arrayBuffer());

    res.writeHead(upstreamResponse.status, {
      'content-type': upstreamResponse.headers.get('content-type') || 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300',
    });
    res.end(body);
  } catch (error) {
    const message = error.name === 'AbortError' ? 'TMDB request timed out' : 'TMDB request failed';
    sendJSON(res, 502, { error: message });
  } finally {
    clearTimeout(timeout);
  }
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJSON(res, 405, { error: 'Method not allowed' });
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }

  if (pathname === '/') pathname = '/index.html';

  const target = path.resolve(PUBLIC_DIR, `.${pathname}`);
  const relative = path.relative(PUBLIC_DIR, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return send(res, 403, 'Forbidden');
  }

  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) return send(res, 404, 'Not found');

    const ext = path.extname(target).toLowerCase();
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();

    const file = await fs.readFile(target);
    res.end(file);
  } catch {
    const index = await fs.readFile(path.join(PUBLIC_DIR, 'index.html'));
    res.writeHead(200, {
      'content-type': MIME['.html'],
      'cache-control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? null : index);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/healthz') {
    return sendJSON(res, 200, { ok: true });
  }

  if (url.pathname === '/api/tmdb' || url.pathname.startsWith('/api/tmdb/')) {
    return proxyTMDB(req, res, url);
  }

  return serveStatic(req, res, url);
});

server.listen(PORT, () => {
  console.log(`SMOTRIM!CHTO is running on http://localhost:${PORT}`);
});
