const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.OPENROUTER_API_KEY;
const CLASS_CODE = process.env.CLASS_CODE || 'manabimap2025';
const PORT = process.env.PORT || 3000;

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
        console.log('analyze called, code match:', code === CLASS_CODE);
        if (code !== CLASS_CODE) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'クラスコードが正しくありません' })); return;
        }
        if (!prompt) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'promptが必要です' })); return;
        }
        const postData = JSON.stringify({
          model: 'openrouter/auto',
          messages: [
            { role: 'system', content: 'You are a Japanese curriculum expert. Return JSON only. No explanation, no markdown.' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.3,
          stream: false
        });
        const options = {
          hostname: 'openrouter.ai',
          path: '/api/v1/chat/completions',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + API_KEY,
            'HTTP-Referer': 'https://manabimap.onrender.com',
            'X-Title': 'ManabiMap',
            'Content-Length': Buffer.byteLength(postData)
          }
        };
        const apiReq = https.request(options, (apiRes) => {
          let data = '';
          console.log('OpenRouter status:', apiRes.statusCode);
          apiRes.on('data', chunk => { data += chunk; });
          apiRes.on('end', () => {
            console.log('OpenRouter response:', data.slice(0, 500));
            try {
              const parsed = JSON.parse(data);
              let content = parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content ? parsed.choices[0].message.content : '';
content = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
              console.log('content:', content.slice(0, 200));
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ content: content }));
            } catch(e) {
              console.log('parse error:', e.message);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'レスポンス解析エラー' }));
            }
          });
        });
        apiReq.on('error', (e) => {
          console.log('OpenRouter error:', e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        });
        apiReq.write(postData);
        apiReq.end();
      } catch(e) {
        console.log('parse error:', e.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '不正なリクエストです' }));
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => { console.log('manabimap server started on port ' + PORT); });
