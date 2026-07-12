const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const EVENTS_FILE = path.join(ROOT, 'events.json');

function safeUserName(name) {
  if (!name) return 'default';
  const m = String(name).match(/[A-Za-z0-9_-]+/g);
  return m ? m.join('').slice(0, 64) : 'default';
}

function userFilePath(user) {
  const uname = safeUserName(user);
  return path.join(ROOT, `events-${uname}.json`);
}

function sendJSON(res, obj, status = 200) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function serveFile(req, res, filepath) {
  fs.readFile(filepath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filepath).toLowerCase();
    const map = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg'
    };
    res.writeHead(200, { 'Content-Type': map[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const method = req.method.toUpperCase();
  if (parsed.pathname === '/events') {
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      res.end();
      return;
    }

    const user = parsed.query.user || req.headers['x-user'] || 'default';
    const filePath = userFilePath(user);
    if (method === 'GET') {
      if (!fs.existsSync(filePath)) {
        return sendJSON(res, []);
      }
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return sendJSON(res, data);
      } catch (e) {
        return sendJSON(res, []);
      }
    }

    if (method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const obj = JSON.parse(body || '[]');
          fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
          return sendJSON(res, { ok: true });
        } catch (e) {
          return sendJSON(res, { ok: false, error: String(e) }, 400);
        }
      });
      return;
    }
  }

  // serve static files (basic)
  let pathname = parsed.pathname;
  if (pathname === '/') pathname = '/calendar.html';
  const filepath = path.join(ROOT, decodeURIComponent(pathname));
  if (fs.existsSync(filepath) && fs.statSync(filepath).isFile()) {
    serveFile(req, res, filepath);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Events server listening on http://localhost:${PORT}/`);
});

module.exports = server;
