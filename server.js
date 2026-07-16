const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const SCHOOL_CODE = process.env.SCHOOL_CODE || 'school2025'; // 学校管理者用コード
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

function supabase(method, path, body, callback) {
  const data = body ? JSON.stringify(body) : null;
  const options = {
    hostname: SUPABASE_URL.replace('https://', ''),
    path: '/rest/v1/' + path,
    method: method,
    headers: {
      'apikey': SUPABASE_SECRET_KEY,
      'Authorization': 'Bearer ' + SUPABASE_SECRET_KEY,
      'Content-Type': 'application/json',
    }
  };
  if (method === 'POST') options.headers['Prefer'] = 'return=representation';
  if (data) options.headers['Content-Length'] = Buffer.byteLength(data);
  const req = https.request(options, (res) => {
    let d = '';
    res.on('data', chunk => d += chunk);
    res.on('end', () => {
      try { callback(null, JSON.parse(d || '[]'), res.statusCode); }
      catch(e) { callback(null, d, res.statusCode); }
    });
  });
  req.on('error', callback);
  if (data) req.write(data);
  req.end();
}

function sendJSON(res, data, status) {
  res.writeHead(status || 200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req, callback) {
  let body = '';
  req.on('data', chunk => { body += chunk.toString(); });
  req.on('end', () => {
    try { callback(null, JSON.parse(body)); }
    catch(e) { callback(e); }
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // index.html
  if (req.method === 'GET' && req.url === '/') {
    fs.readFile(path.join(__dirname, 'index.html'), 'utf8', (err, data) => {
      if (err) { res.writeHead(500); res.end('Error'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // ── クラス管理 ──────────────────────────────

  // クラス一覧取得（学校コードで認証）
  if (req.method === 'GET' && req.url.startsWith('/api/classes')) {
    const params = new URL(req.url, 'http://x').searchParams;
    const schoolCode = params.get('school_code');
    const classCode = params.get('class_code');
    if (classCode) {
      // 特定クラスを取得（class_codeで）
      supabase('GET', 'classes?class_code=eq.'+encodeURIComponent(classCode), null, (err, data) => {
        sendJSON(res, Array.isArray(data) && data.length ? data[0] : null);
      });
    } else if (schoolCode && schoolCode === SCHOOL_CODE) {
      // 学校全体のクラス一覧
      supabase('GET', 'classes?school_code=eq.'+encodeURIComponent(schoolCode)+'&order=created_at.asc', null, (err, data) => {
        sendJSON(res, data || []);
      });
    } else {
      sendJSON(res, { error: 'unauthorized' }, 403);
    }
    return;
  }

  // クラス作成（学校管理者用）
  if (req.method === 'POST' && req.url === '/api/classes') {
    readBody(req, (err, body) => {
      if (err || body.school_code !== SCHOOL_CODE) { sendJSON(res, { error: 'unauthorized' }, 403); return; }
      const cls = {
        id: 'cls' + Date.now(),
        name: body.name || 'クラス',
        school_code: SCHOOL_CODE,
        class_code: body.class_code,
        teacher_password: body.teacher_password,
      };
      supabase('POST', 'classes', cls, (err, data) => {
        sendJSON(res, { ok: true, class: Array.isArray(data) ? data[0] : data });
      });
    });
    return;
  }

  // クラスコード認証（児童・先生共通）
  if (req.method === 'POST' && req.url === '/api/verify') {
    readBody(req, (err, body) => {
      if (err) { res.writeHead(400); res.end(); return; }
      supabase('GET', 'classes?class_code=eq.'+encodeURIComponent(body.code), null, (err, data) => {
        const cls = Array.isArray(data) && data.length ? data[0] : null;
        sendJSON(res, { ok: !!cls, class: cls });
      });
    });
    return;
  }

  // 先生認証
  if (req.method === 'POST' && req.url === '/api/teacher-login') {
    readBody(req, (err, body) => {
      if (err) { res.writeHead(400); res.end(); return; }
      supabase('GET', 'classes?class_code=eq.'+encodeURIComponent(body.code), null, (err, data) => {
        const cls = Array.isArray(data) && data.length ? data[0] : null;
        if (cls && cls.teacher_password === body.password) {
          sendJSON(res, { ok: true, class: cls });
        } else {
          sendJSON(res, { ok: false });
        }
      });
    });
    return;
  }

  // 学校管理者認証
  if (req.method === 'POST' && req.url === '/api/admin-login') {
    readBody(req, (err, body) => {
      if (err) { res.writeHead(400); res.end(); return; }
      sendJSON(res, { ok: body.school_code === SCHOOL_CODE });
    });
    return;
  }

  // ── 児童管理 ──────────────────────────────

  // 児童登録・取得
  if (req.method === 'POST' && req.url === '/api/students') {
    readBody(req, (err, body) => {
      if (err) { sendJSON(res, { error: 'unauthorized' }, 403); return; }
      const classCode = body.code;
      // クラスを確認
      supabase('GET', 'classes?class_code=eq.'+encodeURIComponent(classCode), null, (err, clsData) => {
        const cls = Array.isArray(clsData) && clsData.length ? clsData[0] : null;
        if (!cls) { sendJSON(res, { error: 'invalid class' }, 403); return; }
        // 既存チェック
        supabase('GET', 'students?class_code=eq.'+encodeURIComponent(classCode)+'&name=eq.'+encodeURIComponent(body.name), null, (err, rows) => {
          if (rows && rows.length > 0) {
            sendJSON(res, { student: rows[0] });
          } else {
            const id = 's' + Date.now();
            supabase('POST', 'students', { id, name: body.name, class_code: classCode, class_id: cls.id }, (err, data) => {
              sendJSON(res, { student: Array.isArray(data) ? data[0] : data });
            });
          }
        });
      });
    });
    return;
  }

  // 個別児童取得
  if (req.method === 'GET' && req.url.match(/^\/api\/students\/[^?]+(\?.*)?$/)) {
    const id = req.url.split('/')[3].split('?')[0];
    const code = new URL(req.url, 'http://x').searchParams.get('code');
    supabase('GET', 'students?id=eq.'+id, null, (err, data) => {
      sendJSON(res, Array.isArray(data) && data.length ? data[0] : {});
    });
    return;
  }

  // 全児童取得（先生・クラス別）
  if (req.method === 'GET' && req.url.startsWith('/api/students')) {
    const params = new URL(req.url, 'http://x').searchParams;
    const code = params.get('code');
    const schoolCode = params.get('school_code');
    if (schoolCode && schoolCode === SCHOOL_CODE) {
      // 学校全体の児童
      supabase('GET', 'students?order=created_at.asc', null, (err, data) => {
        sendJSON(res, data || []);
      });
    } else if (code) {
      supabase('GET', 'students?class_code=eq.'+encodeURIComponent(code)+'&order=created_at.asc', null, (err, data) => {
        sendJSON(res, data || []);
      });
    } else {
      sendJSON(res, { error: 'unauthorized' }, 403);
    }
    return;
  }

  // 児童情報更新
  if (req.method === 'PUT' && req.url.startsWith('/api/students/')) {
    const id = req.url.split('/')[3];
    readBody(req, (err, body) => {
      if (err) { sendJSON(res, { error: 'bad request' }, 400); return; }
      const updates = {};
      if (body.grade !== undefined) updates.grade = body.grade;
      if (body.grade_lock !== undefined) updates.grade_lock = body.grade_lock;
      supabase('PATCH', 'students?id=eq.'+id, updates, (err, data) => {
        sendJSON(res, { ok: true });
      });
    });
    return;
  }

  // ── レポート管理 ──────────────────────────────

  // レポート保存
  if (req.method === 'POST' && req.url === '/api/reports') {
    readBody(req, (err, body) => {
      if (err) { sendJSON(res, { error: 'bad request' }, 400); return; }
      const report = {
        id: body.id || ('r' + Date.now()),
        student_id: body.student_id,
        class_code: body.code,
        class_id: body.class_id || null,
        title: body.title || '',
        text: body.text || '',
        photo: body.photo || null,
        grade: body.grade || '',
        grade_auto: body.grade_auto !== false,
        result: body.result,
        unlocked: body.unlocked || {},
        date: body.date || new Date().toISOString()
      };
      supabase('POST', 'reports', report, (err, data) => {
        sendJSON(res, { ok: true, report: Array.isArray(data) ? data[0] : data });
      });
    });
    return;
  }

  // レポート取得（児童別）
  if (req.method === 'GET' && req.url.startsWith('/api/reports/student/')) {
    const studentId = req.url.split('/')[4].split('?')[0];
    supabase('GET', 'reports?student_id=eq.'+studentId+'&order=date.desc', null, (err, data) => {
      sendJSON(res, data || []);
    });
    return;
  }

  // レポート取得（クラス別・先生用）
  if (req.method === 'GET' && req.url.startsWith('/api/reports/all')) {
    const params = new URL(req.url, 'http://x').searchParams;
    const code = params.get('code');
    const schoolCode = params.get('school_code');
    if (schoolCode && schoolCode === SCHOOL_CODE) {
      supabase('GET', 'reports?order=date.desc', null, (err, data) => {
        sendJSON(res, data || []);
      });
    } else if (code) {
      supabase('GET', 'reports?class_code=eq.'+encodeURIComponent(code)+'&order=date.desc', null, (err, data) => {
        sendJSON(res, data || []);
      });
    } else {
      sendJSON(res, { error: 'unauthorized' }, 403);
    }
    return;
  }

  // 先生コメント更新
  if (req.method === 'PUT' && req.url.startsWith('/api/reports/comment/')) {
    const rid = req.url.split('/')[4].split('?')[0];
    readBody(req, (err, body) => {
      if (err) { sendJSON(res, { error: 'bad request' }, 400); return; }
      supabase('PATCH', 'reports?id=eq.'+rid, { teacher_comment: body.comment || '' }, (err, data) => {
        sendJSON(res, { ok: true });
      });
    });
    return;
  }

  // AI分析
  if (req.method === 'POST' && req.url === '/api/analyze') {
    readBody(req, (err, body) => {
      if (err) { sendJSON(res, { error: 'bad request' }, 400); return; }
      const { prompt, raw, image, mediaType } = body;
      const systemPrompt = raw
        ? 'あなたは教育の専門家です。指示された内容を日本語で答えてください。JSONは不要です。'
        : 'あなたは日本の学習指導要領の専門家です。必ずJSONのみを返してください。前置き・説明・コードブロック不要。curriculum_referenceは簡潔な1文のみ。feedbackとoverall_commentには絵文字・特殊記号・特殊文字・装飾文字を一切使わないこと。通常のひらがな・カタカナ・漢字・句読点のみ使用すること。小学1〜3年生の場合はfeedbackとoverall_commentの漢字にHTMLのrubyタグでふりがなを振ること（例：<ruby>学習<rt>がくしゅう</rt></ruby>）。小学4〜6年生は難しい漢字のみrubyタグ。中学生以上はrubyタグ不要。';
      let userContent = image
        ? [{ type: 'image_url', image_url: { url: `data:${mediaType||'image/jpeg'};base64,${image}` } }, { type: 'text', text: prompt }]
        : prompt;
      const postData = JSON.stringify({
        model: 'openrouter/auto',
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }],
        temperature: 0.3, stream: false
      });
      const options = {
        hostname: 'openrouter.ai',
        path: '/api/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + OPENROUTER_API_KEY,
          'HTTP-Referer': 'https://manabimap.onrender.com',
          'X-Title': 'ManabiMap',
          'Content-Length': Buffer.byteLength(postData)
        }
      };
      const apiReq = https.request(options, (apiRes) => {
        let data = '';
        apiRes.on('data', chunk => data += chunk);
        apiRes.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            let content = parsed.choices?.[0]?.message?.content || '';
            if (!raw) content = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
            sendJSON(res, { content });
          } catch(e) { sendJSON(res, { error: 'parse error' }, 500); }
        });
      });
      apiReq.on('error', e => sendJSON(res, { error: e.message }, 500));
      apiReq.write(postData);
      apiReq.end();
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log('manabimap server started on port ' + PORT));
