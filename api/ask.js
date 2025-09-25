// api/ask.js — FINAL v2.0.1 (Language-Scoped Matching + v1/v2 schema compatible)
// - Language-scoped candidates: aliases/keywords_* as { ko, ja, en, zh_tw } maps
// - v1 compatibility: string/array fields still work (treated as 'ko' by default)
// - Robust GET/POST + OPTIONS, CORS, BOM-safe JSON loader
// - Answer fallback order tuned for KO 90% / EN 5% / ZH-TW 5% / JA 0%

const fs = require('fs');
const path = require('path');

/* ============================ 1) Load FAQs (BOM-safe) ============================ */
function safeLoadJson(p) {
  try {
    let raw = fs.readFileSync(p, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // strip BOM
    return JSON.parse(raw);
  } catch (e) {
    console.error(`[ask] JSON load failed for ${p}:`, e && e.message);
    return null;
  }
}

const FAQS = (() => {
  const candidates = [
    path.join(__dirname, 'faqs.json'),            // recommended for Vercel bundling
    path.join(process.cwd(), 'api', 'faqs.json')  // fallback
  ];
  for (const p of candidates) {
    const data = safeLoadJson(p);
    if (Array.isArray(data)) {
      console.log(`[ask] Loaded ${data.length} FAQs from ${p}`);
      return data;
    }
  }
  console.error('[ask] FATAL: Could not load faqs.json from any candidate path.');
  return [];
})();

/* ============================ 2) Config & CORS ============================ */
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const DEFAULT_THRESHOLD = Number(process.env.FAQ_THRESHOLD ?? 0.30);
const MAX_Q_LEN        = Number(process.env.MAX_Q_LEN ?? 300);

function setCorsHeaders(res, origin) {
  const allow = ALLOW_ORIGINS.includes('*')
    ? '*'
    : (ALLOW_ORIGINS.includes(origin) ? origin : (ALLOW_ORIGINS[0] || '*'));
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
}

/* ============================ 3) Text utils & scoring ============================ */
const stripInvisibles = s => String(s ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '');
const cleanText       = s => stripInvisibles(s).normalize('NFKC').toLowerCase();
const removeSpaces    = s => cleanText(s).replace(/\s+/g, '');

const getCharSet = (s) => new Set(Array.from(removeSpaces(s)));
const getBigramSet = (s) => {
  const t = removeSpaces(s);
  const out = new Set();
  if (t.length < 2) return out;
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
};
const jaccard = (A, B) => {
  if (!A.size || !B.size) return 0;
  let I = 0; for (const v of A) if (B.has(v)) I++;
  return I / (A.size + B.size - I);
};
const calculateScore = (q, c) => {
  const Q = removeSpaces(q), C = removeSpaces(c);
  if (!Q || !C) return 0;
  if (Q === C) return 1.0;
  if (Q.includes(C) || C.includes(Q)) return 0.98;
  const s1 = jaccard(getBigramSet(Q), getBigramSet(C)); if (s1 > 0) return s1;
  return jaccard(getCharSet(Q), getCharSet(C));
};

/* ============================ 4) Language detect/normalize ============================ */
// normalize to: 'ko', 'ja', 'en', 'zh_tw'
const normalizeLangTag = (tag) => {
  const s = String(tag || '').toLowerCase().replace('_', '-').trim();
  if (!s) return '';
  if (s.startsWith('ko')) return 'ko';
  if (s.startsWith('ja')) return 'ja';
  if (s.startsWith('en')) return 'en';
  if (s === 'zh-tw' || s === 'zhtw') return 'zh_tw';
  if (s.startsWith('zh')) return 'zh_tw'; // default Chinese to Traditional for Taiwan audience
  return s;
};

function detectLang(query, req) {
  // 1) explicit param/body
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const param = url.searchParams.get('lang') || (req.body && req.body.lang);
    if (param && String(param).toLowerCase() !== 'auto') return normalizeLangTag(param);
  } catch {}

  const s = String(query || '');
  // 2) script-first detection
  if (/[a-zA-Z]/.test(s)) return 'en';
  if (/[가-힣]/.test(s)) return 'ko';
  if (/[\u3040-\u309F\u30A0-\u30FF\uFF66-\uFF9F]/.test(s)) return 'ja';
  if (/[\u4E00-\u9FFF]/.test(s)) {
    try {
      const header = String(req.headers['accept-language'] || '').toLowerCase();
      if (header.startsWith('ja')) return 'ja';
    } catch {}
    return 'zh_tw';
  }
  // 3) header tiebreaker
  try {
    const header = String(req.headers['accept-language'] || '').toLowerCase();
    if (header) return normalizeLangTag(header.split(',')[0]);
  } catch {}
  // 4) default
  return 'ko';
}

/* ============================ 5) v1/v2 schema helpers ============================ */
/** field can be:
 *  - v1: string                  -> return as-is
 *  - v2: { ko, ja, en, zh_tw }   -> pick by lang, fallback to ko/en/ja/zh_tw
 */
function getTextByLang(field, lang) {
  if (typeof field === 'string') return field;
  if (field && typeof field === 'object') {
    return field[lang] ?? field.ko ?? field.en ?? field.ja ?? field.zh_tw ?? field.zh_cn ?? '';
  }
  return '';
}

/** field can be:
 *  - v1: array                   -> return as-is
 *  - v2: { ko:[...], ... }       -> return field[lang] or []
 */
function getListByLang(field, lang) {
  if (Array.isArray(field)) return field;
  if (field && typeof field === 'object') return Array.isArray(field[lang]) ? field[lang] : [];
  return [];
}

/* ============================ 6) Candidate builder (language-scoped) ============================ */
function buildCandidates(faq, lang) {
  const out = [];
  const seen = new Set();
  const add = (text, from) => {
    const t = String(text || '').trim();
    if (!t) return;
    const key = `${from}::${t}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ text: t, from });
  };

  // question (v1/v2)
  add(getTextByLang(faq.question, lang), 'question');

  // language-scoped sets (v1/v2)
  getListByLang(faq.aliases, lang).forEach(v => add(v, 'alias'));
  getListByLang(faq.keywords_core, lang).forEach(v => add(v, 'core'));
  getListByLang(faq.keywords_related, lang).forEach(v => add(v, 'related'));

  return out;
}

/* ============================ 7) Matching (language-scoped search) ============================ */
function findBestMatch(question, lang) {
  let q = String(question || '').trim();
  if (q.length > MAX_Q_LEN) q = q.slice(0, MAX_Q_LEN);

  const qClean = removeSpaces(q);
  if (!qClean) return null;

  let best = { score: -1, entry: null, matched: '', from: '' };

  for (const faq of FAQS) {
    const candidates = buildCandidates(faq, lang);
    for (const c of candidates) {
      const cn = removeSpaces(c.text);
      if (cn && cn === qClean) {
        return { score: 1.0, entry: faq, matched: c.text, from: c.from };
      }
      const sc = calculateScore(q, c.text);
      if (sc > best.score) best = { score: sc, entry: faq, matched: c.text, from: c.from };
    }
  }
  return best.score >= DEFAULT_THRESHOLD ? best : null;
}

/* ============================ 8) Answer & response helpers ============================ */
function getFallbackAnswer(lang) {
  const L = normalizeLangTag(lang);
  if (L === 'ja')    return 'この質問は船社に電話でお問い合わせください。[電話番号]1688-7447';
  if (L === 'zh_tw') return '此問題請直接致電船公司諮詢。[電話號碼]1688-7447';
  if (L === 'en')    return 'For this question, please contact the ferry operator by phone. [Tel] 1688-7447';
  return '이 질문은 선사에 전화문의 부탁드립니다. [전화번호]1688-7447';
}

// ❗ Updated per request: requested → KO → EN → JA → ZH_TW
function pickAnswer(entry, lang) {
  const answers = entry.answers || {};
  const requestedLang = String(lang || '').toUpperCase(); // 'zh_tw' → 'ZH_TW'

  const fallbackOrder = new Set([
    requestedLang, // 요청 언어
    'KO',          // 한국어
    'EN',          // 영어
    'JA',          // 일본어
    'ZH_TW'        // 중국어 번체
  ]);

  for (const key of fallbackOrder) {
    if (answers[key]) return answers[key];
  }
  return Object.values(answers)[0] || ''; // 최후의 보루
}

function buildResponse(match, lang) {
  const url = match.entry.url || null;
  const url_title = match.entry.url_title || null;
  return {
    ok: true,
    lang,
    match: {
      id: match.entry.id,
      question: getTextByLang(match.entry.question, lang) || match.entry.question || '',
      matched: match.matched,
      matched_from: match.from,
      score: +match.score.toFixed(3)
    },
    answer: pickAnswer(match.entry, lang),
    url,
    url_title,
    answer_url: url,
    answer_title: url_title
  };
}

/* ============================ 9) Body reader ============================ */
async function readJsonBody(req) {
  try {
    if (req.body) return (typeof req.body === 'object') ? req.body : JSON.parse(req.body);
    const chunks = []; for await (const ch of req) chunks.push(ch);
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

/* ============================ 10) Handler ============================ */
module.exports = async (req, res) => {
  try {
    setCorsHeaders(res, req.headers.origin);
    if (req.method === 'OPTIONS') return res.status(204).end();

    let question = '';
    let body = {};

    if (req.method === 'GET') {
      let qRaw = '';
      try {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        qRaw = url.searchParams.get('q') || '';
      } catch {}
      if (!qRaw) {
        return res.status(200).json({
          ok: true,
          version: 'faq-api v2.0.1',
          faqs_count: FAQS.length
        });
      }
      try { question = decodeURIComponent(qRaw); } catch { question = qRaw; }
    } else if (req.method === 'POST') {
      body = await readJsonBody(req);
      question = String(body.question || '').trim();
      if (!question) return res.status(400).json({ ok: false, error: 'Missing "question" in POST body' });
    } else {
      return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    }

    const lang = detectLang(question, { ...req, body });
    const match = findBestMatch(question, lang);

    if (!match) {
      return res.status(200).json({ ok: true, lang, match: null, answer: getFallbackAnswer(lang) });
    }

    return res.status(200).json(buildResponse(match, lang));

  } catch (e) {
    console.error('Server Error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'Internal Server Error' });
  }
};
