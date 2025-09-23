// api/ask.js — FINAL PRODUCTION BUILD v1.2
// - Script-first detection (JA 힌트 포함), 중국어 기본 번체
// - pickAnswer: 통일 로직 (요청 언어→중국어면 번체 우선→KO→JA→EN→기타 중국어→임의 1개)
// - Robust GET/POST + CORS, BOM-safe JSON loader, exact-first 매칭

const fs = require('fs');
const path = require('path');

/* ===== 1) FAQs Loader (BOM-safe, multi-path) ===== */
function safeLoadJson(p) {
  try {
    let raw = fs.readFileSync(p, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch (e) {
    console.error(`[ask] JSON load failed for ${p}:`, e.message);
    return null;
  }
}
const FAQS = (() => {
  const candidates = [
    path.join(__dirname, 'faqs.json'),
    path.join(process.cwd(), 'api', 'faqs.json')
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

/* ===== 2) CORS ===== */
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || '*').split(',').map(s => s.trim());
function setCorsHeaders(res, origin) {
  const allow = ALLOW_ORIGINS.includes('*') ? '*' :
    (ALLOW_ORIGINS.includes(origin) ? origin : (ALLOW_ORIGINS[0] || '*'));
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
}

/* ===== 3) Matching Config ===== */
const DEFAULT_THRESHOLD = Number(process.env.FAQ_THRESHOLD ?? 0.30);
const MIN_QUERY_CHARS   = Number(process.env.FAQ_MIN_QUERY_CHARS ?? 2);

/* ===== 4) Text utils & scoring ===== */
const stripInvisibles = (s) => String(s ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '');
const cleanText       = (s) => stripInvisibles(s).normalize('NFKC').toLowerCase();
const removeSpaces    = (s) => cleanText(s).replace(/\s+/g, '');
const getCharSet      = (s) => new Set(Array.from(removeSpaces(s)));
const getBigramSet    = (s) => {
  const t = removeSpaces(s); const out = new Set();
  if (t.length < 2) return out;
  for (let i=0;i<t.length-1;i++) out.add(t.slice(i,i+2));
  return out;
};
const jaccard = (A,B) => { if(!A.size||!B.size) return 0; let I=0; for(const v of A) if(B.has(v)) I++; return I/(A.size+B.size-I); };
const calculateScore = (q,c) => {
  const Q=removeSpaces(q), C=removeSpaces(c);
  if(!Q||!C) return 0;
  if(Q===C) return 1.0;
  if(Q.includes(C)||C.includes(Q)) return 0.98;
  const s1=jaccard(getBigramSet(Q),getBigramSet(C)); if(s1>0) return s1;
  return jaccard(getCharSet(Q),getCharSet(C));
};

/* ===== 5) Language detection & normalization ===== */
const normalizeLangTag = (tag) => {
  const s = String(tag || '').toLowerCase().replace('_','-').trim();
  if (!s) return '';
  if (s === 'zh' || s.startsWith('zh-')) {
    if (s.includes('cn') || s.includes('sg') || s.includes('hans')) return 'zh-hans';
    return 'zh-hant';
  }
  if (s === 'zh-tw' || s === 'zhtw') return 'zh-hant';
  if (s === 'zh-cn' || s === 'zhcn') return 'zh-hans';
  if (s.startsWith('ko')) return 'ko';
  if (s.startsWith('ja')) return 'ja';
  if (s.startsWith('en')) return 'en';
  return s;
};
const detectLang = (query, req) => {
  // 1) ?lang / body.lang
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const param = url.searchParams.get('lang') || (req.body && req.body.lang);
    if (param && String(param).toLowerCase() !== 'auto') return normalizeLangTag(param);
  } catch {}
  const s = String(query || '');
  // 2) script-first
  if (/[가-힣]/.test(s)) return 'ko';
  if (/[\u3040-\u309F]/.test(s) || /[\u30A0-\u30FF\uFF66-\uFF9F]/.test(s)) return 'ja';
  if (/[\u4E00-\u9FFF]/.test(s)) {
    if (/手荷物|船内持込|船內持込|円|樣|様|さん|です|ます|ください|頂き/.test(s)) return 'ja';
    return 'zh-hant';
  }
  // 3) Accept-Language
  try {
    const header = String(req.headers['accept-language'] || '').toLowerCase();
    if (header) {
      const primary = header.split(',')[0];
      const normalized = normalizeLangTag(primary);
      if (normalized) return normalized;
    }
  } catch {}
  // 4) fallback
  if (/[a-zA-Z]/.test(s)) return 'en';
  return 'ko';
};

/* ===== 6) Answer selection (통일 로직) ===== */
const pickAnswer = (entry, langInput) => {
  const lang = normalizeLangTag(langInput || '');
  const answers = (entry.answers && typeof entry.answers === 'object') ? entry.answers : {};
  const m = {};
  for (const [k, v] of Object.entries(answers)) {
    const kk = String(k).toLowerCase().replace('_', '-');
    m[kk] = v;
    if (kk === 'zh-tw') m['zh-hant'] = v;
    if (kk === 'zh-cn' || kk === 'zh') m['zh-hans'] = v;
  }
  return (
    m[lang] ||
    (lang.startsWith('zh') ? (m['zh-hant'] || m['zh-tw']) : undefined) ||
    m['ko'] || m['ja'] || m['en'] ||
    m['zh-hant'] || m['zh-tw'] || m['zh'] || m['zh-hans'] ||
    Object.values(m)[0] || ''
  );
};

/* ===== 7) Candidates ===== */
const buildCandidates = (faq) => {
  const out = []; const seen = new Set();
  const add = (text, from) => {
    const t = String(text || ''); if (!t) return;
    const key = `${from}::${t}`; if (seen.has(key)) return;
    seen.add(key); out.push({ text: t, from });
  };
  add(faq.question, 'question');
  (faq.aliases || []).forEach(v => add(v, 'alias'));
  (faq.keywords_core || []).forEach(v => add(v, 'core'));
  (faq.keywords_related || []).forEach(v => add(v, 'related'));
  return out;
};

/* ===== 8) Matching (exact-first, 1-char exact) ===== */
const findBestMatch = (question) => {
  const q = String(question || '').trim();
  const qClean = removeSpaces(q);
  if (qClean.length < MIN_QUERY_CHARS) {
    for (const f of FAQS) {
      for (const c of buildCandidates(f)) {
        if (removeSpaces(c.text) === qClean) {
          return { score: 1.0, entry: f, matched: c.text, from: c.from };
        }
      }
    }
    return null;
  }
  let best = { score: -1, entry: null, matched: '', from: '' };
  for (const f of FAQS) {
    for (const c of buildCandidates(f)) {
      const cn = removeSpaces(c.text);
      if (cn && cn === qClean) {
        return { score: 1.0, entry: f, matched: c.text, from: c.from };
      }
      const sc = calculateScore(q, c.text);
      if (sc > best.score) best = { score: sc, entry: f, matched: c.text, from: c.from };
    }
  }
  return best.score >= DEFAULT_THRESHOLD ? best : null;
};

/* ===== 9) Helpers ===== */
const getFallbackAnswer = (lang) => {
  const L = normalizeLangTag(lang);
  if (L === 'ja')         return 'この質問は船社に電話でお問い合わせください。[電話番号]1688-7447';
  if (L.startsWith('zh')) return '此問題請直接致電船公司諮詢。[電話號碼]1688-7447';
  if (L === 'en')         return 'For this question, please contact the ferry operator by phone. [Tel] 1688-7447';
  return '이 질문은 선사에 전화문의 부탁드립니다. [전화번호]1688-7447';
};
const buildResponse = (match, lang) => {
  let finalLang = normalizeLangTag(lang);
  const JA_KANJI_HINTS = new Set(['手荷物','船内持込','船內持込']);
  if (String(finalLang).startsWith('zh') && JA_KANJI_HINTS.has(String(match.matched || ''))) {
    finalLang = 'ja';
  }
  const url = match.entry.url || null;
  const url_title = match.entry.url_title || null;
  const sources = url ? [{ id: match.entry.id, url, title: url_title || url }] : undefined;
  return {
    ok: true,
    lang: finalLang,
    match: {
      id: match.entry.id,
      question: match.entry.question,
      matched: match.matched,
      matched_from: match.from,
      score: +match.score.toFixed(3)
    },
    answer: pickAnswer(match.entry, finalLang),
    url, url_title,
    answer_url: url, answer_title: url_title,
    sources
  };
};
async function readJsonBody(req) {
  try {
    if (req.body) return (typeof req.body === 'object') ? req.body : JSON.parse(req.body);
    const chunks = []; for await (const ch of req) chunks.push(ch);
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

/* ===== 10) Handler ===== */
module.exports = async (req, res) => {
  try {
    setCorsHeaders(res, req.headers.origin);
    if (req.method === 'OPTIONS') return res.status(204).end();

    if (req.method === 'GET') {
      let qRaw = '';
      try {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        qRaw = url.searchParams.get('q') || '';
      } catch {}
      if (!qRaw) {
        return res.status(200).json({
          ok: true,
          version: 'faq-api FINAL v1.2',
          methods: ['GET','POST'],
          faqs_count: FAQS.length,
          sample: FAQS[0]?.question || null
        });
      }
      let question = qRaw; try { question = decodeURIComponent(qRaw); } catch {}
      const lang = detectLang(question, req);
      const match = findBestMatch(question);
      if (!match) return res.status(200).json({ ok: true, lang, match: null, answer: getFallbackAnswer(lang) });
      return res.status(200).json(buildResponse(match, lang));
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const question = String(body.question || '').trim();
      if (!question) return res.status(400).json({ ok: false, error: 'Missing "question" in POST body' });
      const lang = detectLang(question, { ...req, body });
      const match = findBestMatch(question);
      if (!match) return res.status(200).json({ ok: true, lang, match: null, answer: getFallbackAnswer(lang) });
      return res.status(200).json(buildResponse(match, lang));
    }

    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  } catch (e) {
    console.error('Server Error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'Internal Server Error' });
  }
};
