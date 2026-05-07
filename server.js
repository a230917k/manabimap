const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.GEMINI_API_KEY;
const CLASS_CODE = process.env.CLASS_CODE || 'manabimap2025';
const PORT = process.env.PORT || 3000;
const GEMINI_MODEL = 'gemini-2.5-flash';

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/') {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, 'utf8', (err, data) => {
      if (err) { res.writeHead(500); res.end('Error'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/verify') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const { code } = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: code === CLASS_CODE }));
      } catch(e) { res.writeHead(400); res.end('Bad request'); }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/analyze') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const { prompt, code } = JSON.parse(body);
        if (code !== CLASS_CODE) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'クラスコードが正しくありません' })); return;
        }
        if (!prompt) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'promptが必要です' })); return;
        }
        const postData = JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3 }
        });
        const options = {
          hostname: 'generativelanguage.googleapis.com',
          path: `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${API_KEY}`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
        };
        const apiReq = https.request(options, (apiRes) => {
          let data = '';
          apiRes.on('data', chunk => { data += chunk; });
          apiRes.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(data); });
        });
        apiReq.on('error', (e) => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); });
        apiReq.write(postData);
        apiReq.end();
      } catch(e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '不正なリクエストです' })); }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => { console.log(`まなびマップ サーバー起動: ポート${PORT}`); });
