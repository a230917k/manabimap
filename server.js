const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const SCHOOL_CODE = process.env.SCHOOL_CODE || 'school2025'; // 学校管理者用コード
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

// 8桁アカウントIDを生成
// 学年変換（数字→日本語）
function convertGrade(gradeStr) {
  if (!gradeStr) return '';
  const g = String(gradeStr).trim();
  const map = {
    '1':'小1','2':'小2','3':'小3','4':'小4','5':'小5','6':'小6',
    '7':'中1','8':'中2','9':'中3','10':'高1','11':'高2','12':'高3',
    '小1':'小1','小2':'小2','小3':'小3','小4':'小4','小5':'小5','小6':'小6',
    '中1':'中1','中2':'中2','中3':'中3','高1':'高1','高2':'高2','高3':'高3',
  };
  return map[g] || g;
}

// ── 年度ユーティリティ（4月1日始まり）──────────────
function currentYear(d) {
  const t = d ? new Date(d) : new Date();
  const m = t.getMonth() + 1; // 1-12
  return m >= 4 ? t.getFullYear() : t.getFullYear() - 1;
}
function parseYear(v) {
  const n = parseInt(v, 10);
  return (!isNaN(n) && n >= 2000 && n <= 2100) ? n : currentYear();
}

// ── お知らせ ────────────────────────────────────
function createNotification(n, cb) {
  const rec = {
    id: 'n' + Date.now() + Math.random().toString(36).slice(2, 6),
    kind: n.kind || 'system',
    title: n.title || '',
    body: n.body || '',
    audience: n.audience || 'admin',
    audience_key: n.audience_key || '',
    school_code: SCHOOL_CODE,
    actor_name: n.actor_name || '',
    target_name: n.target_name || '',
    before_value: n.before_value || '',
    after_value: n.after_value || '',
    link_type: n.link_type || '',
    link_id: n.link_id || '',
    created_at: new Date().toISOString()
  };
  supabase('POST', 'notifications', rec, (e, d) => { if (cb) cb(e, d); });
}

// 設定値の取得
function getSetting(key, fallback, cb) {
  supabase('GET', 'school_settings?key=eq.' + encodeURIComponent(key), null, (e, rows) => {
    if (Array.isArray(rows) && rows.length && rows[0].value) cb(rows[0].value);
    else cb(fallback);
  });
}

function genAccountId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい文字を除外
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

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
  if (method === 'POST' || method === 'PATCH') options.headers['Prefer'] = 'return=representation';
  if (data) options.headers['Content-Length'] = Buffer.byteLength(data);
  const req = https.request(options, (res) => {
    // バイト列のまま貯め、受信完了後に一度だけ UTF-8 へ変換する。
    // チャンクの境目で日本語や絵文字が分断されるのを防ぐため。
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => {
      const d = Buffer.concat(chunks).toString('utf8');
      try { callback(null, JSON.parse(d || '[]'), res.statusCode); }
      catch(e) { callback(null, d, res.statusCode); }
    });
  });
  req.on('error', callback);
  if (data) req.write(data);
  req.end();
}

function sendJSON(res, data, status) {
  // charset を明示しないとブラウザ側の推測で化けることがある
  res.writeHead(status || 200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req, callback) {
  // chunk.toString() を逐次呼ぶと、マルチバイト文字が
  // チャンク境界で壊れる。Buffer のまま連結してから変換する。
  const chunks = [];
  req.on('data', chunk => { chunks.push(chunk); });
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
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
        account_id: body.account_id || genAccountId(),
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

  // 先生認証（teachersテーブル＋classesテーブル両対応）
  if (req.method === 'POST' && req.url === '/api/teacher-login') {
    readBody(req, (err, body) => {
      if (err) { res.writeHead(400); res.end(); return; }
      const { account_id, password, code } = body;
      if (account_id) {
        // 先生アカウントIDでログイン
        supabase('GET', 'teachers?account_id=eq.'+encodeURIComponent(account_id), null, (err, tData) => {
          const teacher = Array.isArray(tData) && tData.length ? tData[0] : null;
          if (!teacher || teacher.password !== password) {
            sendJSON(res, { ok: false }); return;
          }
          // 所属クラスを取得
          supabase('GET', 'classes?class_code=eq.'+encodeURIComponent(teacher.class_code), null, (err, cData) => {
            const cls = Array.isArray(cData) && cData.length ? cData[0] : null;
            sendJSON(res, { ok: true, class: cls, teacher });
          });
        });
      } else if (code) {
        // クラスコード＋パスワードでログイン（後方互換）
        supabase('GET', 'classes?class_code=eq.'+encodeURIComponent(code), null, (err, data) => {
          const cls = Array.isArray(data) && data.length ? data[0] : null;
          if (cls && cls.teacher_password === password) {
            sendJSON(res, { ok: true, class: cls });
          } else {
            sendJSON(res, { ok: false });
          }
        });
      } else {
        sendJSON(res, { ok: false });
      }
    });
    return;
  }

  // 先生一覧取得
  if (req.method === 'GET' && req.url.startsWith('/api/teachers')) {
    const params = new URL(req.url, 'http://x').searchParams;
    const classCode = params.get('class_code');
    const schoolCode = params.get('school_code');
    if (schoolCode && schoolCode === SCHOOL_CODE) {
      supabase('GET', 'teachers?school_code=eq.'+encodeURIComponent(schoolCode)+'&order=created_at.asc', null, (err, data) => {
        sendJSON(res, data || []);
      });
    } else if (classCode) {
      supabase('GET', 'teachers?class_code=eq.'+encodeURIComponent(classCode)+'&order=created_at.asc', null, (err, data) => {
        sendJSON(res, data || []);
      });
    } else {
      sendJSON(res, { error: 'unauthorized' }, 403);
    }
    return;
  }

  // 先生登録
  if (req.method === 'POST' && req.url === '/api/teachers') {
    readBody(req, (err, body) => {
      if (err || body.school_code !== SCHOOL_CODE) { sendJSON(res, { error: 'unauthorized' }, 403); return; }
      const teacher = {
        id: 't' + Date.now(),
        account_id: body.account_id || genAccountId(),
        name: body.name,
        yomi: body.yomi || '',
        role: body.role || '',
        class_code: body.class_code,
        school_code: SCHOOL_CODE,
        password: body.password || genAccountId().toLowerCase(),
      };
      supabase('POST', 'teachers', teacher, (err, data) => {
        sendJSON(res, { ok: true, teacher: Array.isArray(data) ? data[0] : data });
      });
    });
    return;
  }

  // 先生削除
  if (req.method === 'DELETE' && req.url.startsWith('/api/teachers/')) {
    const id = req.url.split('/')[3];
    readBody(req, (err, body) => {
      if (err || !body || body.school_code !== SCHOOL_CODE) { sendJSON(res, { error: 'unauthorized' }, 403); return; }
      supabase('DELETE', 'teachers?id=eq.'+id, null, (err, data) => {
        sendJSON(res, { ok: true });
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
        // 既存チェック（名前またはふりがなで検索）
        supabase('GET', 'students?class_code=eq.'+encodeURIComponent(classCode)+'&name=eq.'+encodeURIComponent(body.name), null, (err, rows) => {
          if (rows && rows.length > 0) {
            sendJSON(res, { student: rows[0] }); return;
          }
          // ふりがなでも検索
          supabase('GET', 'students?class_code=eq.'+encodeURIComponent(classCode)+'&yomi=eq.'+encodeURIComponent(body.name), null, (err, rows2) => {
            if (rows2 && rows2.length > 0) {
              sendJSON(res, { student: rows2[0] }); return;
            }
            {
            const id = 's' + Date.now();
            supabase('POST', 'students', {
              id,
              account_id: body.account_id || genAccountId(),
              name: body.name,
              yomi: body.yomi || '',
              role: body.role || '',
              seq: body.seq || null,
              class_code: classCode,
              class_id: cls.id
            }, (err, data) => {
              sendJSON(res, { student: Array.isArray(data) ? data[0] : data });
            });
            }
          });
        });
      });
    });
    return;
  }

  // 児童ログイン（クラスコード＋アカウントID＋名前の3つで認証）
  if (req.method === 'POST' && req.url === '/api/students/login') {
    readBody(req, (err, body) => {
      if (err) { sendJSON(res, { error: 'bad request' }, 400); return; }
      const { account_id, name, code } = body;
      if (!account_id || !name || !code) {
        sendJSON(res, { error: 'missing fields' }, 400); return;
      }
      // クラスコード＋アカウントIDで検索
      supabase('GET',
        'students?account_id=eq.'+encodeURIComponent(account_id)+'&class_code=eq.'+encodeURIComponent(code),
        null, (err, data) => {
          const student = Array.isArray(data) && data.length ? data[0] : null;
          if (!student) { sendJSON(res, { student: null }); return; }
          // 名前照合（空白の全角/半角/なしを吸収）
          function normalizeName(s) {
            if (!s) return '';
            return s
              .replace(/　/g, '') // 全角スペース除去
              .replace(/\s+/g, '')    // 半角スペース・空白除去
              .toLowerCase();
          }
          const inputNorm = normalizeName(name);
          const nameMatch = normalizeName(student.name) === inputNorm
                         || normalizeName(student.yomi) === inputNorm;
          if (nameMatch) {
            sendJSON(res, { student });
          } else {
            sendJSON(res, { student: null });
          }
        }
      );
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

  // 全児童取得（先生・クラス別）※年度の在籍で絞る
  if (req.method === 'GET' && req.url.startsWith('/api/students')) {
    const params = new URL(req.url, 'http://x').searchParams;
    const code = params.get('code');
    const schoolCode = params.get('school_code');
    const year = parseYear(params.get('year'));

    // 在籍（enrollments）と児童（students）を結合して返す
    function withEnrollments(enrollPath, fallback) {
      supabase('GET', enrollPath, null, (err, enrolls) => {
        if (!Array.isArray(enrolls) || !enrolls.length) {
          // 在籍データがない年度は空（ただし移行前の互換として fallback）
          if (fallback) { fallback(); return; }
          sendJSON(res, []); return;
        }
        supabase('GET', 'students?order=created_at.asc', null, (err2, studs) => {
          const byId = {};
          (studs || []).forEach(s => { byId[s.id] = s; });
          const merged = enrolls.map(e => {
            const s = byId[e.student_id];
            if (!s) return null;
            return Object.assign({}, s, {
              class_code: e.class_code,
              class_id:   e.class_id,
              grade:      e.grade || s.grade || '',
              seq:        (e.seq !== null && e.seq !== undefined) ? e.seq : s.seq,
              role:       e.role || s.role || '',
              year:       e.year
            });
          }).filter(Boolean);
          sendJSON(res, merged);
        });
      });
    }

    if (schoolCode && schoolCode === SCHOOL_CODE) {
      withEnrollments('enrollments?year=eq.'+year+'&order=seq.asc',
        () => supabase('GET', 'students?order=created_at.asc', null, (e, d) => sendJSON(res, d || [])));
    } else if (code) {
      withEnrollments('enrollments?year=eq.'+year+'&class_code=eq.'+encodeURIComponent(code)+'&order=seq.asc',
        () => supabase('GET', 'students?class_code=eq.'+encodeURIComponent(code)+'&order=created_at.asc', null, (e, d) => sendJSON(res, d || [])));
    } else {
      sendJSON(res, { error: 'unauthorized' }, 403);
    }
    return;
  }

  // ── 在籍・年度管理 ──────────────────────────────

  // 利用可能な年度一覧
  if (req.method === 'GET' && req.url.startsWith('/api/years')) {
    supabase('GET', 'enrollments?select=year', null, (err, data) => {
      const set = {};
      (data || []).forEach(r => { if (r.year) set[r.year] = true; });
      const years = Object.keys(set).map(Number).sort((a,b) => b - a);
      if (!years.length) years.push(currentYear());
      sendJSON(res, { years, current: currentYear() });
    });
    return;
  }

  // 進級処理（次年度の在籍を作る）
  if (req.method === 'POST' && req.url === '/api/enrollments/promote') {
    readBody(req, (err, body) => {
      if (err) { sendJSON(res, { error: 'bad request' }, 400); return; }
      if (body.school_code !== SCHOOL_CODE) { sendJSON(res, { error: 'unauthorized' }, 403); return; }
      const fromYear = parseYear(body.from_year);
      const toYear   = parseYear(body.to_year);
      // 学年を1つ進める
      const nextGrade = (g) => {
        const m = String(g || '').match(/^(小|中)(\d)$/);
        if (!m) return g || '';
        const kind = m[1], n = parseInt(m[2], 10);
        if (kind === '小') return n < 6 ? '小' + (n + 1) : '中1';
        return n < 3 ? '中' + (n + 1) : '';  // 中3は卒業
      };
      supabase('GET', 'enrollments?year=eq.'+fromYear, null, (err2, rows) => {
        if (!Array.isArray(rows) || !rows.length) { sendJSON(res, { ok: true, created: 0 }); return; }
        const targets = rows.map(r => ({ r, g: nextGrade(r.grade) })).filter(x => x.g); // 卒業者は除外
        let done = 0, created = 0;
        if (!targets.length) { sendJSON(res, { ok: true, created: 0, graduated: rows.length }); return; }
        targets.forEach(({ r, g }) => {
          const rec = {
            id: 'e' + r.student_id + '_' + toYear,
            student_id: r.student_id,
            year: toYear,
            class_code: r.class_code,   // クラスは名簿読み込みで上書きする前提
            class_id: r.class_id,
            grade: g,
            seq: r.seq,
            role: r.role || ''
          };
          supabase('POST', 'enrollments', rec, () => {
            created++; done++;
            if (done === targets.length) {
              sendJSON(res, { ok: true, created, graduated: rows.length - targets.length });
            }
          });
        });
      });
    });
    return;
  }

  // 在籍の個別登録・更新（非常用の手入力）
  if (req.method === 'POST' && req.url === '/api/enrollments') {
    readBody(req, (err, body) => {
      if (err) { sendJSON(res, { error: 'bad request' }, 400); return; }
      const year = parseYear(body.year);
      const rec = {
        id: 'e' + body.student_id + '_' + year,
        student_id: body.student_id,
        year: year,
        class_code: body.class_code || '',
        class_id: body.class_id || null,
        grade: body.grade || '',
        seq: body.seq || null,
        role: body.role || ''
      };
      // 既存があれば更新、なければ作成
      supabase('GET', 'enrollments?student_id=eq.'+encodeURIComponent(body.student_id)+'&year=eq.'+year, null, (e, rows) => {
        if (Array.isArray(rows) && rows.length) {
          supabase('PATCH', 'enrollments?id=eq.'+encodeURIComponent(rows[0].id), {
            class_code: rec.class_code, class_id: rec.class_id,
            grade: rec.grade, seq: rec.seq, role: rec.role
          }, (e2, d) => sendJSON(res, { ok: true, updated: true }));
        } else {
          supabase('POST', 'enrollments', rec, (e2, d) => sendJSON(res, { ok: true, created: true }));
        }
      });
    });
    return;
  }

  // 児童情報更新
  if (req.method === 'PUT' && req.url.startsWith('/api/students/')) {
    const id = req.url.split('/')[3].split('?')[0];
    readBody(req, (err, body) => {
      if (err) { sendJSON(res, { error: 'bad request' }, 400); return; }
      const byAdmin = body.school_code === SCHOOL_CODE;

      // 変更前の値を取っておく（通知の履歴に使う）
      supabase('GET', 'students?id=eq.'+id, null, (e0, before) => {
        const prev = (Array.isArray(before) && before.length) ? before[0] : {};
        const updates = {};
        const changes = [];   // {label, from, to}

        // 先生が変更できる項目
        if (body.name !== undefined && body.name !== prev.name) {
          updates.name = body.name;
          changes.push({ label: '氏名', from: prev.name || '', to: body.name });
        }
        if (body.yomi !== undefined && body.yomi !== prev.yomi) {
          updates.yomi = body.yomi;
          changes.push({ label: 'ふりがな', from: prev.yomi || '', to: body.yomi });
        }
        if (body.seq !== undefined && String(body.seq) !== String(prev.seq)) {
          updates.seq = body.seq;
          changes.push({ label: '出席番号', from: String(prev.seq || ''), to: String(body.seq || '') });
        }

        // 管理者のみ変更できる項目
        if (byAdmin) {
          if (body.account_id !== undefined && body.account_id !== prev.account_id) {
            updates.account_id = body.account_id;
            changes.push({ label: 'アカウントID', from: prev.account_id || '', to: body.account_id });
          }
          if (body.class_code !== undefined && body.class_code !== prev.class_code) {
            updates.class_code = body.class_code;
            changes.push({ label: 'クラス', from: prev.class_code || '', to: body.class_code });
          }
          if (body.grade !== undefined && body.grade !== prev.grade) {
            updates.grade = body.grade;
            changes.push({ label: '学年', from: prev.grade || '', to: body.grade });
          }
          if (body.grade_lock !== undefined) updates.grade_lock = body.grade_lock;
        } else {
          // 先生からの grade 変更は従来どおり許可（学年設定機能のため）
          if (body.grade !== undefined && body.grade !== prev.grade) {
            updates.grade = body.grade;
            changes.push({ label: '学年', from: prev.grade || '', to: body.grade });
          }
          if (body.grade_lock !== undefined) updates.grade_lock = body.grade_lock;
          // account_id / class_code は無視する
        }

        if (!Object.keys(updates).length) { sendJSON(res, { ok: true, changed: 0 }); return; }

        supabase('PATCH', 'students?id=eq.'+id, updates, (err2) => {
          // 在籍側にも出席番号・学年を反映
          if (updates.seq !== undefined || updates.grade !== undefined) {
            const y = parseYear(body.year);
            supabase('GET', 'enrollments?student_id=eq.'+encodeURIComponent(id)+'&year=eq.'+y, null, (e3, rows) => {
              if (Array.isArray(rows) && rows.length) {
                const u2 = {};
                if (updates.seq !== undefined) u2.seq = updates.seq;
                if (updates.grade !== undefined) u2.grade = updates.grade;
                supabase('PATCH', 'enrollments?id=eq.'+encodeURIComponent(rows[0].id), u2, () => {});
              }
            });
          }

          // 氏名・ふりがな・出席番号が変わったら管理者へ通知
          const notable = changes.filter(x => ['氏名','ふりがな','出席番号','アカウントID','クラス'].indexOf(x.label) >= 0);
          if (!notable.length) { sendJSON(res, { ok: true, changed: changes.length }); return; }

          getSetting('student_edit_audience', 'admin', (aud) => {
            const name = updates.name || prev.name || '児童';
            const detail = notable.map(x => x.label + '「' + (x.from || '（空）') + '」→「' + (x.to || '（空）') + '」').join('\n');
            const base = {
              kind: 'student_edit',
              title: name + 'さんの情報が変更されました',
              body: detail,
              actor_name: body.actor_name || '先生',
              target_name: name,
              before_value: notable.map(x => x.label + ':' + (x.from || '')).join(' / '),
              after_value:  notable.map(x => x.label + ':' + (x.to   || '')).join(' / '),
              link_type: 'student',
              link_id: id
            };
            // 管理者には必ず届ける
            createNotification(Object.assign({}, base, { audience: 'admin' }), () => {});
            if (aud === 'grade' && (updates.grade || prev.grade)) {
              createNotification(Object.assign({}, base, { audience: 'grade', audience_key: updates.grade || prev.grade }), () => {});
            } else if (aud === 'teachers') {
              createNotification(Object.assign({}, base, { audience: 'teachers' }), () => {});
            }
            sendJSON(res, { ok: true, changed: changes.length });
          });
        });
      });
    });
    return;
  }

  // ── お知らせ API ───────────────────────────────

  // 自分あてのお知らせ一覧
  if (req.method === 'GET' && req.url.startsWith('/api/notifications')) {
    const p = new URL(req.url, 'http://x').searchParams;
    const role      = p.get('role') || 'student';   // admin / teacher / student
    const readerId  = p.get('reader_id') || '';
    const grade     = p.get('grade') || '';
    const classCode = p.get('code') || '';

    supabase('GET', 'notifications?order=created_at.desc&limit=100', null, (e, rows) => {
      const all = Array.isArray(rows) ? rows : [];
      const mine = all.filter(n => {
        if (role === 'admin')   return n.audience === 'admin' || n.audience === 'teachers';
        if (role === 'teacher') {
          if (n.audience === 'teachers') return true;
          if (n.audience === 'grade')    return n.audience_key === grade;
          if (n.audience === 'class')    return n.audience_key === classCode;
          return false;
        }
        // 児童
        if (n.audience === 'student') return n.audience_key === readerId;
        if (n.audience === 'class')   return n.audience_key === classCode;
        return false;
      });
      if (!mine.length) { sendJSON(res, { items: [], unread: 0 }); return; }
      supabase('GET', 'notification_reads?reader_id=eq.'+encodeURIComponent(readerId), null, (e2, reads) => {
        const readSet = {};
        (Array.isArray(reads) ? reads : []).forEach(r => { readSet[r.notif_id] = true; });
        const items = mine.map(n => Object.assign({}, n, { is_read: !!readSet[n.id] }));
        sendJSON(res, { items, unread: items.filter(x => !x.is_read).length });
      });
    });
    return;
  }

  // 既読にする
  if (req.method === 'POST' && req.url === '/api/notifications/read') {
    readBody(req, (err, body) => {
      if (err) { sendJSON(res, { error: 'bad request' }, 400); return; }
      const readerId = body.reader_id || '';
      const ids = Array.isArray(body.notif_ids) ? body.notif_ids : (body.notif_id ? [body.notif_id] : []);
      if (!readerId || !ids.length) { sendJSON(res, { ok: true, marked: 0 }); return; }
      let done = 0;
      ids.forEach(nid => {
        supabase('POST', 'notification_reads', {
          id: nid + '__' + readerId, notif_id: nid, reader_id: readerId,
          read_at: new Date().toISOString()
        }, () => { done++; if (done === ids.length) sendJSON(res, { ok: true, marked: ids.length }); });
      });
    });
    return;
  }

  // お知らせを作る（コメント・課題配信などから呼ぶ）
  if (req.method === 'POST' && req.url === '/api/notifications') {
    readBody(req, (err, body) => {
      if (err) { sendJSON(res, { error: 'bad request' }, 400); return; }
      createNotification(body, () => sendJSON(res, { ok: true }));
    });
    return;
  }

  // 学校設定の取得・更新
  if (req.method === 'GET' && req.url.startsWith('/api/settings')) {
    supabase('GET', 'school_settings', null, (e, rows) => {
      const out = {};
      (Array.isArray(rows) ? rows : []).forEach(r => { out[r.key] = r.value; });
      sendJSON(res, out);
    });
    return;
  }
  if (req.method === 'PUT' && req.url.startsWith('/api/settings')) {
    readBody(req, (err, body) => {
      if (err) { sendJSON(res, { error: 'bad request' }, 400); return; }
      if (body.school_code !== SCHOOL_CODE) { sendJSON(res, { error: 'unauthorized' }, 403); return; }
      const key = body.key, value = body.value || '';
      if (!key) { sendJSON(res, { error: 'bad request' }, 400); return; }
      supabase('GET', 'school_settings?key=eq.'+encodeURIComponent(key), null, (e, rows) => {
        if (Array.isArray(rows) && rows.length) {
          supabase('PATCH', 'school_settings?key=eq.'+encodeURIComponent(key),
            { value: value, updated_at: new Date().toISOString() }, () => sendJSON(res, { ok: true }));
        } else {
          supabase('POST', 'school_settings', { key: key, value: value }, () => sendJSON(res, { ok: true }));
        }
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
        is_homework: body.is_homework || false,
        assignment_id: body.assignment_id || '',
        date: body.date || new Date().toISOString(),
        year: body.year || currentYear(body.date)
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
    const yParam = new URL(req.url, 'http://x').searchParams.get('year');
    // year=all なら全年度（累積）、未指定も全年度を返しフロントで絞る
    let path = 'reports?student_id=eq.'+studentId;
    if (yParam && yParam !== 'all') path += '&year=eq.'+parseYear(yParam);
    path += '&order=date.desc';
    supabase('GET', path, null, (err, data) => {
      sendJSON(res, data || []);
    });
    return;
  }

  // レポート取得（クラス別・先生用）
  if (req.method === 'GET' && req.url.startsWith('/api/reports/all')) {
    const params = new URL(req.url, 'http://x').searchParams;
    const code = params.get('code');
    const schoolCode = params.get('school_code');
    const yParam = params.get('year');
    const yFilter = (yParam && yParam !== 'all') ? '&year=eq.'+parseYear(yParam) : '';
    if (schoolCode && schoolCode === SCHOOL_CODE) {
      supabase('GET', 'reports?order=date.desc'+yFilter, null, (err, data) => {
        sendJSON(res, data || []);
      });
    } else if (code) {
      supabase('GET', 'reports?class_code=eq.'+encodeURIComponent(code)+yFilter+'&order=date.desc', null, (err, data) => {
        sendJSON(res, data || []);
      });
    } else {
      sendJSON(res, { error: 'unauthorized' }, 403);
    }
    return;
  }

  // 課題一覧取得
  if (req.method === 'GET' && req.url.startsWith('/api/assignments')) {
    const params = new URL(req.url, 'http://x').searchParams;
    const classCode = params.get('class_code');
    const schoolCode = params.get('school_code');
    const studentId = params.get('student_id');
    if (studentId) {
      // 児童向け：学校全体・学年・クラス・個人の課題を全取得
      supabase('GET', 'students?id=eq.'+studentId, null, (err, stuData) => {
        const stu = Array.isArray(stuData)&&stuData.length?stuData[0]:null;
        if (!stu) { sendJSON(res, []); return; }
        // school_codeはSCHOOL_CODEを使う（studentsテーブルにはない）
        supabase('GET', 'assignments?school_code=eq.'+encodeURIComponent(SCHOOL_CODE)+'&order=created_at.desc', null, (err, data) => {
          const all = Array.isArray(data)?data:[];
          // target_typeで絞り込み
          const filtered = all.filter(a => {
            if (a.target_type === 'school') return true;
            if (a.target_type === 'grade') {
              // 学年一致チェック（「小4」=「小4」）
              return stu.grade && stu.grade === a.target_value;
            }
            if (a.target_type === 'class') {
              // クラスコード一致チェック
              return stu.class_code === a.target_value;
            }
            if (a.target_type === 'group' || a.target_type === 'individual') {
              try {
                const ids = JSON.parse(a.target_value||'[]');
                return ids.includes(studentId);
              } catch(e){ return false; }
            }
            return false;
          });
          sendJSON(res, filtered);
        });
      });
    } else if (schoolCode && schoolCode === SCHOOL_CODE) {
      supabase('GET', 'assignments?school_code=eq.'+encodeURIComponent(schoolCode)+'&order=created_at.desc', null, (err, data) => {
        sendJSON(res, data||[]);
      });
    } else if (classCode) {
      supabase('GET', 'assignments?class_code=eq.'+encodeURIComponent(classCode)+'&order=created_at.desc', null, (err, data) => {
        sendJSON(res, data||[]);
      });
    } else {
      sendJSON(res, { error: 'unauthorized' }, 403);
    }
    return;
  }

  // 課題作成
  if (req.method === 'POST' && req.url === '/api/assignments') {
    readBody(req, (err, body) => {
      if (err) { sendJSON(res, { error: 'bad request' }, 400); return; }
      const assignment = {
        id: 'a' + Date.now(),
        title: body.title || '課題',
        content: body.content || '',
        goal: body.goal || '',
        rubric: body.rubric || '',
        teacher_id: body.teacher_id || '',
        class_code: body.class_code || '',
        school_code: SCHOOL_CODE,
        target_type: body.target_type || 'class',
        target_value: body.target_value || '',
        due_date: body.due_date || null,
      };
      supabase('POST', 'assignments', assignment, (err, data) => {
        // 配信先の児童へお知らせ
        const notif = {
          kind: 'assignment',
          title: '新しい課題がとどきました',
          body: assignment.title,
          actor_name: body.actor_name || '先生',
          link_type: 'assignment',
          link_id: assignment.id
        };
        const tt = assignment.target_type, tv = assignment.target_value;
        if (tt === 'student' && tv) {
          // 個人指定（カンマ区切りの児童ID）
          String(tv).split(',').map(s => s.trim()).filter(Boolean).forEach(sid => {
            createNotification(Object.assign({}, notif, { audience: 'student', audience_key: sid }), () => {});
          });
          sendJSON(res, { ok: true, assignment: Array.isArray(data)?data[0]:data });
        } else if (tt === 'class' || !tt) {
          createNotification(Object.assign({}, notif, {
            audience: 'class', audience_key: assignment.class_code
          }), () => sendJSON(res, { ok: true, assignment: Array.isArray(data)?data[0]:data }));
        } else {
          // 学年・グループ・学校全体は該当児童へ個別に配る
          let path = 'enrollments?year=eq.' + currentYear();
          if (tt === 'grade' && tv) path += '&grade=eq.' + encodeURIComponent(tv);
          supabase('GET', path, null, (e2, enrolls) => {
            const list = Array.isArray(enrolls) ? enrolls : [];
            list.forEach(en => {
              createNotification(Object.assign({}, notif, {
                audience: 'student', audience_key: en.student_id
              }), () => {});
            });
            sendJSON(res, { ok: true, assignment: Array.isArray(data)?data[0]:data });
          });
        }
      });
    });
    return;
  }

  // 課題削除
  if (req.method === 'DELETE' && req.url.startsWith('/api/assignments/')) {
    const id = req.url.split('/')[3];
    supabase('DELETE', 'assignments?id=eq.'+id, null, (err, data) => {
      sendJSON(res, { ok: true });
    });
    return;
  }

  // グループ一覧取得
  if (req.method === 'GET' && req.url.startsWith('/api/groups')) {
    const params = new URL(req.url, 'http://x').searchParams;
    const classCode = params.get('class_code');
    supabase('GET', 'groups?class_code=eq.'+encodeURIComponent(classCode||'')+'&order=created_at.asc', null, (err, data) => {
      sendJSON(res, data||[]);
    });
    return;
  }

  // グループ作成
  if (req.method === 'POST' && req.url === '/api/groups') {
    readBody(req, (err, body) => {
      if (err) { sendJSON(res, { error: 'bad request' }, 400); return; }
      const group = {
        id: 'g' + Date.now(),
        name: body.name || 'グループ',
        class_code: body.class_code || '',
        school_code: SCHOOL_CODE,
        student_ids: body.student_ids || [],
      };
      supabase('POST', 'groups', group, (err, data) => {
        sendJSON(res, { ok: true, group: Array.isArray(data)?data[0]:data });
      });
    });
    return;
  }

  // グループ更新
  if (req.method === 'PUT' && req.url.startsWith('/api/groups/')) {
    const id = req.url.split('/')[3];
    readBody(req, (err, body) => {
      if (err) { sendJSON(res, { error: 'bad request' }, 400); return; }
      supabase('PATCH', 'groups?id=eq.'+id, { name: body.name, student_ids: body.student_ids }, (err, data) => {
        sendJSON(res, { ok: true });
      });
    });
    return;
  }

  // グループ削除
  if (req.method === 'DELETE' && req.url.startsWith('/api/groups/')) {
    const id = req.url.split('/')[3];
    supabase('DELETE', 'groups?id=eq.'+id, null, (err, data) => {
      sendJSON(res, { ok: true });
    });
    return;
  }

  // 課題別提出レポート取得
  if (req.method === 'GET' && req.url.startsWith('/api/reports/assignment/')) {
    const aid = req.url.split('/')[4].split('?')[0];
    supabase('GET', 'reports?assignment_id=eq.'+encodeURIComponent(aid)+'&order=date.desc', null, (err, data) => {
      sendJSON(res, data || []);
    });
    return;
  }

  // 先生コメント・点数・既読更新
  if (req.method === 'PUT' && req.url.startsWith('/api/reports/comment/')) {
    const rid = req.url.split('/')[4].split('?')[0];
    readBody(req, (err, body) => {
      if (err) { sendJSON(res, { error: 'bad request' }, 400); return; }
      const updates = {};
      if (body.comment !== undefined) updates.teacher_comment = body.comment || '';
      if (body.teacher_score !== undefined) updates.teacher_score = body.teacher_score;
      if (body.read_by_teacher !== undefined) updates.read_by_teacher = body.read_by_teacher;
      if (body.teacher_adjustment !== undefined) updates.teacher_adjustment = body.teacher_adjustment;
      supabase('PATCH', 'reports?id=eq.'+rid, updates, (err, data) => {
        // コメントや点数がついたら児童本人へお知らせ
        const hasFeedback = (body.comment !== undefined && body.comment) || body.teacher_score !== undefined;
        if (!hasFeedback) { sendJSON(res, { ok: true }); return; }
        supabase('GET', 'reports?id=eq.'+rid, null, (e2, rows) => {
          const rep = (Array.isArray(rows) && rows.length) ? rows[0] : null;
          if (!rep || !rep.student_id) { sendJSON(res, { ok: true }); return; }
          const bits = [];
          if (body.teacher_score !== undefined && body.teacher_score !== null) bits.push('点数: ' + body.teacher_score + '点');
          if (body.comment) bits.push(body.comment);
          createNotification({
            kind: 'comment',
            title: '先生からコメントがとどきました',
            body: bits.join('\n'),
            audience: 'student',
            audience_key: rep.student_id,
            actor_name: body.actor_name || '先生',
            link_type: 'report',
            link_id: rid
          }, () => sendJSON(res, { ok: true }));
        });
      });
    });
    return;
  }

  // CSVインポート（一括登録）
  if (req.method === 'POST' && req.url === '/api/import') {
    readBody(req, (err, body) => {
      if (err || body.school_code !== SCHOOL_CODE) { sendJSON(res, { error: 'unauthorized' }, 403); return; }
      const records = body.records || [];
      const importYear = parseYear(body.year);
      let created = { classes: 0, students: 0, teachers: 0, enrollments: 0 };
      let pending = records.length;
      if (!pending) { sendJSON(res, { ok: true, created }); return; }

      const done = () => { if (--pending === 0) sendJSON(res, { ok: true, created }); };

      records.forEach(r => {
        if (r.type === 'class') {
          const cls = {
            id: 'cls' + Date.now() + Math.random().toString(36).slice(2,5),
            account_id: r.account_id || genAccountId(),
            name: r.name,
            school_code: SCHOOL_CODE,
            class_code: r.class_code || genAccountId().toLowerCase(),
            teacher_password: r.teacher_password || genAccountId().toLowerCase(),
          };
          supabase('POST', 'classes', cls, (e, d) => { created.classes++; done(); });
        } else if (r.type === 'student' || r.type === '児童') {
          const grade = convertGrade(r.grade);
          const seqVal = r.seq ? parseInt(r.seq) : null;

          // 在籍レコードを作る（既存なら更新）
          const upsertEnrollment = (studentId, classId, isNew) => {
            const rec = {
              id: 'e' + studentId + '_' + importYear,
              student_id: studentId,
              year: importYear,
              class_code: r.class_code || '',
              class_id: classId || null,
              grade: grade,
              seq: seqVal,
              role: r.role || ''
            };
            supabase('GET', 'enrollments?student_id=eq.'+encodeURIComponent(studentId)+'&year=eq.'+importYear, null, (e, rows) => {
              if (Array.isArray(rows) && rows.length) {
                supabase('PATCH', 'enrollments?id=eq.'+encodeURIComponent(rows[0].id), {
                  class_code: rec.class_code, class_id: rec.class_id,
                  grade: rec.grade, seq: rec.seq, role: rec.role
                }, () => { if (isNew) created.students++; else created.enrollments++; done(); });
              } else {
                supabase('POST', 'enrollments', rec, () => { if (isNew) created.students++; else created.enrollments++; done(); });
              }
            });
          };

          const proceed = (classId) => {
            // 既存児童を account_id で照合（なければ氏名）
            const findPath = r.account_id
              ? 'students?account_id=eq.'+encodeURIComponent(r.account_id)
              : 'students?name=eq.'+encodeURIComponent(r.name);
            supabase('GET', findPath, null, (e, found) => {
              if (Array.isArray(found) && found.length) {
                // 既存児童 → 在籍だけ更新（進級・クラス替え）
                const sid = found[0].id;
                supabase('PATCH', 'students?id=eq.'+sid, {
                  grade: grade, grade_lock: grade ? true : false,
                  class_code: r.class_code || '', class_id: classId || null,
                  seq: seqVal, role: r.role || ''
                }, () => upsertEnrollment(sid, classId, false));
              } else {
                const sid = 's' + Date.now() + Math.random().toString(36).slice(2,5);
                const stu = {
                  id: sid,
                  account_id: r.account_id || genAccountId(),
                  name: r.name,
                  yomi: r.yomi || '',
                  role: r.role || '',
                  seq: seqVal,
                  grade: grade,
                  grade_lock: grade ? true : false,
                  class_code: r.class_code || '',
                  class_id: classId || null,
                };
                supabase('POST', 'students', stu, () => upsertEnrollment(sid, classId, true));
              }
            });
          };

          if (r.class_code) {
            supabase('GET', 'classes?class_code=eq.'+encodeURIComponent(r.class_code), null, (e, clsData) => {
              const cls = Array.isArray(clsData) && clsData.length ? clsData[0] : null;
              proceed(cls ? cls.id : null);
            });
          } else {
            proceed(null);
          }
        } else if (r.type === 'teacher' || r.type === '先生') {
          const teacher = {
            id: 't' + Date.now() + Math.random().toString(36).slice(2,5),
            account_id: r.account_id || genAccountId(),
            name: r.name,
            yomi: r.yomi || '',
            role: r.role || '',
            class_code: r.class_code || '',
            school_code: SCHOOL_CODE,
            password: r.password || genAccountId().toLowerCase(),
          };
          supabase('POST', 'teachers', teacher, (e, d) => { created.teachers++; done(); });
        } else {
          done();
        }
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
        : 'あなたは日本の学習指導要領の専門家です。必ずJSONのみを返してください。前置き・説明・コードブロック不要。curriculum_referenceは簡潔な1文のみ。feedbackとoverall_commentには絵文字を使ってよいですが、サロゲートペアになる文字（壊れて表示される文字）は使わないこと。小学1〜3年生の場合はfeedbackとoverall_commentの漢字にHTMLのrubyタグでふりがなを振ること（例：<ruby>学習<rt>がくしゅう</rt></ruby>）。小学4〜6年生は難しい漢字のみrubyタグ。中学生以上はrubyタグ不要。';
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
        // 絵文字などの4バイト文字がチャンク境界で割れないよう
        // Buffer で受けてから一括で UTF-8 変換する
        const chunks = [];
        apiRes.on('data', chunk => chunks.push(chunk));
        apiRes.on('end', () => {
          const data = Buffer.concat(chunks).toString('utf8');
          try {
            const parsed = JSON.parse(data);
            let content = parsed.choices?.[0]?.message?.content || '';
            if (!raw) content = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
            // 壊れた文字だけを除去する。
            // 正しいサロゲートペア（絵文字）は残し、対になっていない
            // 単独サロゲートと置換文字だけを捨てる。
            content = content
              .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')  // 対のない上位
              .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')  // 対のない下位
              .replace(/\uFFFD/g, '');                                // 置換文字
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
