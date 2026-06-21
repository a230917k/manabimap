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
        const { prompt, code, raw, image, mediaType } = JSON.parse(body);
        console.log('analyze called, code match:', code === CLASS_CODE, 'raw:', !!raw);
        if (code !== CLASS_CODE) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'クラスコードが正しくありません' })); return;
        }
        if (!prompt) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'promptが必要です' })); return;
        }
        const systemPrompt = raw
          ? 'あなたは教育の専門家です。指示された内容を日本語で答えてください。JSONは不要です。'
          : 'あなたは日本の学習指導要領の専門家です。必ずJSONのみを返してください。前置き・説明・コードブロック不要。curriculum_referenceは簡潔な1文のみ。feedbackとoverall_commentには絵文字・特殊記号・特殊文字・装飾文字を一切使わないこと。通常のひらがな・カタカナ・漢字・句読点のみ使用すること。小学1〜3年生の場合はfeedbackとoverall_commentの漢字にHTMLのrubyタグでふりがなを振ること（例：<ruby>学習<rt>がくしゅう</rt></ruby>）。小学4〜6年生は難しい漢字のみrubyタグ。中学生以上はrubyタグ不要。';
        let userContent;
        if (image) {
          // 画像付きリクエスト
          userContent = [
            { type: 'image_url', image_url: { url: `data:${mediaType||'image/jpeg'};base64,${image}` } },
            { type: 'text', text: prompt }
          ];
        } else {
          userContent = prompt;
        }
        const postData = JSON.stringify({
          model: 'openrouter/auto',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent }
          ],
          temperature: 0.3,
          stream: false
        });
        callOpenRouter(postData, raw, res);
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '不正なリクエストです' }));
      }
    });
    return;
  }

  // 画像OCRエンドポイント
  if (req.method === 'POST' && req.url === '/api/ocr') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const { image, mediaType, code } = JSON.parse(body);
        console.log('ocr called, code match:', code === CLASS_CODE);
        if (code !== CLASS_CODE) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'クラスコードが正しくありません' })); return;
        }
        if (!image) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '画像データが必要です' })); return;
        }
        const postData = JSON.stringify({
          model: 'google/gemini-2.0-flash-exp:free',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: { url: `data:${mediaType||'image/jpeg'};base64,${image}` }
                },
                {
                  type: 'text',
                  text: 'この画像に書かれている手書きの文字をすべて読み取って、そのままテキストにしてください。文字が読み取れない部分は「（読み取り不可）」と書いてください。余分な説明は不要です。'
                }
              ]
            }
          ],
          temperature: 0.1,
          stream: false
        });
        callOpenRouter(postData, true, res);
      } catch(e) {
        console.log('ocr error:', e.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '不正なリクエストです' }));
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

function callOpenRouter(postData, raw, res) {
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
      console.log('OpenRouter response:', data.slice(0, 300));
      try {
        const parsed = JSON.parse(data);
        let content = parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content
          ? parsed.choices[0].message.content : '';
        if (!raw) {
          content = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        }
        console.log('content:', content.slice(0, 200));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ content }));
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
}

server.listen(PORT, () => { console.log('manabimap server started on port ' + PORT); });
