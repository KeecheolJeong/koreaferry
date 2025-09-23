// api/ask.js — Clean Consolidated Stable
// CORS + Lang detection (JA guard) + zh-Hans/Hant normalize + robust JSON loading + exact-match fast path

const fs = require('fs');
const path = require('path');

/* ===== 1) Load FAQs (bundled api/faqs.json; fallback paths) ===== */
function tryReadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
let FAQS = (() => {
  const candidates = [
    path.join(__dirname, 'faqs.json'),                         // api/faqs.json (권장)
    path.join(process.cwd(), 'data', 'faqs.json'),             // fallback
    path.join(process.cwd(), 'public', 'faqs.json'),
    path.join(process.cwd(), 'faqs.json'),
  ];
  for (const p of candidates) {
    const d = tryReadJson(p);
    if (Array.isArray(d)) return d;
  }
  console.error('[ask] Failed to load faqs.json from candidates');
  return [];
})();

/* ===== 2) CORS ===== */
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || '*')
  .split(',').map(s => s.trim());
function setCors(res, origin) {
  const allow = ALLOW_ORIGINS.includes('*') ? '*' :
    (ALLOW_ORIGINS.includes(origin) ? origin : (ALLOW_ORIGINS[0] || '*'));
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
}

/* ===== 3) Matching config (short query guard) ===== */
const HARD_MIN = Number(process.env.FAQ_HARD_MIN ?? 0.30);
const DEFAULT_THRESHOLD = Number(process.env.FAQ_THRESHOLD ?? 0.30);
const MIN_QUERY_CHARS = Number(process.env.FAQ_MIN_QUERY_CHARS ?? 2);

/* ===== 4) Text utils & scoring ===== */
const stripInvis = s => String(s ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '');
const clean      = s => stripInvis(String(s ?? '')).normalize('NFKC').toLowerCase();
const noSpace    = s => clean(s).replace(/\s+/g, '');
const charSet    = s => new Set(Array.from(noSpace(s)));
function bigramSet(s) {
  const t = noSpace(s), out = new Set();
  if (t.length < 2) return out;
  for (let i = 0; i < t.length - 1; i++) out.add(t[i] + t[i + 1]);
  return out;
}
function jaccardSets(A, B) {
  if (!A.size || !B.size) return { score: 0, inter: 0 };
  let inter = 0; for (const v of A) if (B.has(v)) inter++;
  const score = inter / (A.size + B.size - inter);
  return { score, inter };
}
function dynamicThreshold(q) {
  const n = noSpace(q).length;
  if (n <= 1) return 1.0;
  if (n === 2) return 0.98;
  if (n === 3) return 0.60;
  if (n <= 5) return 0.40;
  return DEFAULT_THRESHOLD;
}
function score(q, c) {
  const Q = noSpace(q), C = noSpace(c);
  if (!Q || !C) return 0;
  if (Q === C) return 1.0; // exact
  if (Q.includes(C) || C.includes(Q)) return 0.98; // contains
  const QB = bigramSet(Q), CB = bigramSet(C);
  if (QB.size && CB.size) {
    const { score } = jaccardSets(QB, CB);
    if (score > 0) return score;
  }
  const { score: s } = jaccardSets(charSet(Q), charSet(C));
  return s;
}

/* ===== 5) Lang normalize & detect ===== */
function normalizeLangTag(tagRaw) {
  const t = String(tagRaw || '').toLowerCase().replace('_','-').trim();
  if (!t) return '';
  if (t === 'zh' || t.startsWith('zh-')) {
    if (t.includes('tw') || t.includes('hk') || t.includes('mo') || t.includes('hant')) return 'zh-hant';
    if (t.includes('cn') || t.includes('sg') || t.includes('hans')) return 'zh-hans';
    return 'zh-hans';
  }
  if (t === 'zh_tw' || t === 'zhtw') return 'zh-hant';
  if (t === 'zh_cn' || t === 'zhcn') return 'zh-hans';
  if (t.startsWith('ko')) return 'ko';
  if (t.startsWith('ja')) return 'ja';
  if (t.startsWith('en')) return 'en';
  return t;
}
function detectLang(q, req) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.searchParams.get('lang') || (req.body && req.body.lang);
    if (p && String(p).toLowerCase() !== 'auto') return normalizeLangTag(p);
  } catch {}
  const accept = String(req.headers['accept-language'] || '').toLowerCase();
  if (accept.startsWith('ja')) return 'ja';
  if (accept.startsWith('ko')) return 'ko';
  if (accept.startsWith('zh')) return normalizeLangTag(accept.split(',')[0]);
  const s = String(q || '');
  const hasHira = /[\u3040-\u309F]/.test(s);
  const hasKata = /[\u30A0-\u30FF\uFF66-\uFF9F]/.test(s);
  const hasHangul = /[\uAC00-\uD7AF]/.test(s);
  const hasHan = /[\u4E00-\u9FFF]/.test(s);
  if (hasHangul) return 'ko';
  if (hasHira || hasKata) return 'ja';
  if (hasHan) {
    const jaHints = /[の・〜～円樣様さんですますください頂き]/.test(s);
    return jaHints ? 'ja' : 'zh-hans';
  }
  return 'en';
}

/* ===== 6) Answer picker (mixed schema tolerant) ===== */
function pickAnswer(entry, langInput) {
  const lang = normalizeLangTag(langInput || '');
  const ans = (entry.answers && typeof entry.answers === 'object') ? entry.answers : null;
  if (ans) {
    const normAns = {};
    for (const [k, v] of Object.entries(ans)) {
      const kk = String(k).toLowerCase().replace('_','-');
      normAns[kk] = v;
      if (kk === 'zh-tw') normAns['zh-hant'] = v;
      if (kk === 'zh-cn') normAns['zh-hans'] = v;
    }
    if (lang === 'zh-hant') return normAns['zh-hant'] || normAns['zh'] || normAns['zh-hans'] || '';
    if (lang === 'zh-hans') return normAns['zh-hans'] || normAns['zh'] || normAns['zh-hant'] || '';
    if (normAns[lang]) return normAns[lang];
    for (const k of ['ko','ja','zh-hant','zh-hans','zh','en']) if (normAns[k]) return normAns[k];
  }
  const map = { 'ko':'answer_ko', 'ja':'answer_ja', 'zh-hans':'answer_zh', 'zh-hant':'answer_zh', 'en':'answer_en' };
  const altKey = map[lang];
  if (altKey && typeof entry[altKey] === 'string' && entry[altKey]) return entry[altKey];
  if (typeof entry.answer === 'string' && entry.answer) return entry.answer;
  for (const k of ['answer_ko','answer_ja','answer_zh','answer_en']) if (entry[k]) return entry[k];
  return '';
}

/* ===== 7) Candidate builder ===== */
function buildCandidates(faq) {
  const out = [], seen = new Set();
  const push = (text, from) => {
    const t = String(text || ''); if (!t) return;
    const key = `${from}::${t}`; if (seen.has(key)) return;
    seen.add(key); out.push({ text: t, from });
  };
  if (faq.question) push(faq.question, 'question');
  for (const v of (faq.aliases || []))          push(v, 'alias');
  for (const v of (faq.keywords_core || []))    push(v, 'core');
  for (const v of (faq.keywords_related || [])) push(v, 'related');
  return out;
}

/* ===== 8) Best match (with exact-match fast pass) ===== */
function bestMatch(question, lang, baseThreshold = DEFAULT_THRESHOLD) {
  const q = String(question || '').trim();
  const qn = noSpace(q);
  if (qn.length < MIN_QUERY_CHARS) return null;

  const dynT = dynamicThreshold(q);
  const threshold = Math.max(dynT, HARD_MIN, baseThreshold);

  let best = { score: -1, entry: null, matched: '', matched_from: '' };
  for (const f of FAQS) {
    const cands = buildCandidates(f);
    for (const c of cands) {
      const cn = noSpace(c.text);
      if (cn && cn === qn) { // exact-match → immediate accept
        return { score: 1.0, entry: f, matched: c.text, matched_from: c.from };
      }
      const sc = score(q, c.text);
      if (sc > best.score) best = { score: sc, entry: f, matched: c.text, matched_from: c.from };
    }
  }
  return best.score >= threshold ? best : null;
}

/* ===== 9) Safe JSON body reader (POST) ===== */
async function readJsonBody(req) {
  try {
    if (req.body) {
      if (typeof req.body === 'string') return JSON.parse(req.body);
      if (typeof req.body === 'object') return req.body;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

/* ===== 10) Handler ===== */
module.exports = async (req, res) => {
  try {
    setCors(res, req.headers.origin);
    if (req.method === 'OPTIONS') return res.status(204).end();

    if (req.method === 'GET') {
      // support both status (no q) and answer (q)
      let qRaw = '', diag = '';
      try {
        if (req.query) { qRaw = req.query.q || ''; diag = req.query.diag || ''; }
        else { const u = new URL(req.url, 'http://localhost'); qRaw = u.searchParams.get('q') || ''; diag = u.searchParams.get('diag') || ''; }
      } catch {}
      if (!qRaw) {
        return res.status(200).json({
          ok: true,
          version: 'faq-api stable v2',
          methods: ['GET', 'POST'],
          faqs_count: FAQS.length,
          sample: FAQS[0]?.question || null
        });
      }
      let question = qRaw; try { question = decodeURIComponent(qRaw); } catch {}
      const lang = detectLang(question, req);
      const baseT = Number(process.env.FAQ_THRESHOLD ?? DEFAULT_THRESHOLD);
      const match = bestMatch(question, lang, baseT);

      if (!match) {
         const fallback = lang === 'ja'
    ? 'この質問は船社に電話でお問い合わせください。[電話番号]1688-7447'
    : lang === 'zh-hant'
    ? '此問題請直接致電船公司諮詢。[電話號碼]1688-7447'
    : lang === 'zh-hans' || String(lang).startsWith('zh')
    ? '此问题请直接致电船公司咨询。[电话号码]1688-7447'
    : '이 질문은 선사에 전화문의 부탁드립니다. [전화번호]1688-7447';
        return res.status(200).json({ ok: true, lang, match: null, answer: fallback });
      }
      const url = match.entry.url || null;
      const url_title = match.entry.url_title || null;
      const sources = url ? [{ id: match.entry.id, url, title: url_title || url }] : undefined;

      return res.status(200).json({
        ok: true,
        lang,
        match: {
          id: match.entry.id,
          question: match.entry.question,
          matched: match.matched,
          matched_from: match.matched_from,
          score: +match.score.toFixed(3),
        },
        answer: pickAnswer(match.entry, lang),
        url, url_title, answer_url: url, answer_title: url_title,
        sources,
      });
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const question = String(body.question || '').trim();
      if (!question) return res.status(400).json({ ok: false, error: 'Missing "question"' });

      const lang = normalizeLangTag(body.lang || detectLang(question, req));
      const baseT = Number(process.env.FAQ_THRESHOLD ?? DEFAULT_THRESHOLD);
      const match = bestMatch(question, lang, baseT);

      if (!match) {
        return res.status(200).json({
          ok: true,
          lang,
          match: null,
          answer: '이 문의는 직접 선사에 문의 부탁드립니다. \n [전화번호] 051-410-7800~7',
        });
      }
      const url = match.entry.url || null;
      const url_title = match.entry.url_title || null;
      const sources = url ? [{ id: match.entry.id, url, title: url_title || url }] : undefined;

      return res.status(200).json({
        ok: true,
        lang,
        match: {
          id: match.entry.id,
          question: match.entry.question,
          matched: match.matched,
          matched_from: match.matched_from,
          score: +match.score.toFixed(3),
        },
        answer: pickAnswer(match.entry, lang),
        url, url_title, answer_url: url, answer_title: url_title,
        sources,
      });
    }

    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  } catch (e) {
    console.error('Server Error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'Server Error' });
  }
};
