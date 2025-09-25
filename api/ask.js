// api/ask.js — ARCHITECTURE REVISION v2.0
// - Language-scoped candidates: aliases/keywords_* as { ko, ja, en, zh_tw } maps
// - v1 compatibility: string/array fields still work (treated as 'ko' by default)
// - Robust GET/POST + OPTIONS, CORS, BOM-safe JSON loader

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
    path.join(__dirname, 'faqs.json'),         // recommended for Vercel bundling
    path.join(process.cwd(), 'api', 'faqs.json') // fallback
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
const MAX_Q_LEN         = Number(process.env.MAX_Q_LEN ?? 300);

function setCorsHeaders(res, origin) {
  const allow = ALLOW_ORIGINS.includes('*')
    ? '*'
    : (ALLOW_ORIGINS.includes(origin) ? origin : (ALLOW_ORIGINS[0] || '*'));
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}


/* ============================ 3) Text utils & scoring ============================ */
const cleanText      = s => String(s ?? '').normalize('NFKC').toLowerCase();
const removeSpaces   = s => cleanText(s).replace(/\s+/g, '');
const getCharSet     = s => new Set(Array.from(removeSpaces(s)));
const getBigramSet   = s => {
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
const normalizeLangTag = (tag) => {
  const s = String(tag || '').toLowerCase().replace('_', '-').trim();
  if (!s) return '';
  if (s.startsWith('ko')) return 'ko';
  if (s.startsWith('ja')) return 'ja';
  if (s.startsWith('en')) return 'en';
  if (s === 'zh-tw' || s === 'zhtw') return 'zh_tw'; // Use zh_tw to match faqs.json keys
  if (s.startsWith('zh')) return 'zh_tw'; // Default any Chinese to Traditional
  return s;
};

function detectLang(query, req) {
  try {
    const param = (req.body && req.body.lang) || new URL(req.url, `http://${req.headers.host}`).searchParams.get('lang');
    if (param && String(param).toLowerCase() !== 'auto') return normalizeLangTag(param);
  } catch {}
  const s = String(query || '');
  if (/[a-zA-Z]/.test(s)) return 'en';
  if (/[가-힣]/.test(s)) return 'ko';
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(s)) return 'ja';
  if (/[\u4E00-\u9FFF]/.test(s)) {
    try {
      const header = String(req.headers['accept-language'] || '').toLowerCase();
      if (header.startsWith('ja')) return 'ja';
    } catch {}
    return 'zh_tw';
  }
  try {
    const header = String(req.headers['accept-language'] || '').toLowerCase();
    if (header) return normalizeLangTag(header.split(',')[0]);
  } catch {}
  return 'ko';
}


/* ============================ 5) v1/v2 schema helpers ============================ */
function getTextByLang(field, lang) {
  if (typeof field === 'string') return field; // v1 compat
  if (field && typeof field === 'object') {
    return field[lang] ?? field.ko ?? field.en ?? field.ja ?? field.zh_tw ?? '';
  }
  return '';
}
function getListByLang(field, lang) {
  if (Array.isArray(field)) return field; // v1 compat
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
  add(getTextByLang(faq.question, lang), 'question');
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
      if (removeSpaces(c.text) === qClean) {
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
function pickAnswer(entry, lang) {
  const answers = entry.answers || {};
  const requestedLang = String(lang || '').toUpperCase().replace('ZH-TW', 'ZH_TW');
  const fallbackOrder = new Set([requestedLang, 'KO', 'EN', 'JA', 'ZH_TW']);
  for (const key of fallbackOrder) {
    if (answers[key]) return answers[key];
  }
  return Object.values(answers)[0] || '';
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
      const qRaw = new URL(req.url, `http://${req.headers.host}`).searchParams.get('q') || '';
      if (!qRaw) {
        return res.status(200).json({ ok: true, version: 'faq-api v2.0', faqs_count: FAQS.length });
      }
      question = decodeURIComponent(qRaw);
    } else if (req.method === 'POST') {
      body = await readJsonBody(req);
      question = String(body.question || '').trim();
      if (!question) return res.status(400).json({ ok: false, error: 'Missing "question"' });
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