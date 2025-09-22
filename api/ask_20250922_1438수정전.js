// api/ask.js
const fs = require('fs');
const path = require('path');

/* -------------------------------------------------------------
 * Load FAQs once (robust path for Vercel)
 * ----------------------------------------------------------- */
const FAQS = (() => {
  try {
    const filePath = path.resolve(__dirname, '..', 'data', 'faqs.json');
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error('Failed to load faqs.json:', error);
    return [];
  }
})();

/* -------------------------------------------------------------
 * CORS (for browser fetch from WordPress, etc.)
 *  - env ALLOW_ORIGINS: comma separated origins
 *  - default: "*" (모두 허용)
 * ----------------------------------------------------------- */
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || '*')
  .split(',')
  .map(s => s.trim());

function setCors(res, origin) {
  const allow =
    ALLOW_ORIGINS.includes('*') ? '*' :
    (ALLOW_ORIGINS.includes(origin) ? origin : (ALLOW_ORIGINS[0] || '*'));
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/* -------------------------------------------------------------
 * Text utils (normalize / tokenization / scoring)
 * ----------------------------------------------------------- */
const stripInvis = (s) => String(s ?? '').replace(/[\u200B-\u200D\uFEFF]/g, ''); // ZWSP/ZWNJ/ZWJ/BOM
const clean      = (s) => stripInvis(String(s ?? '')).normalize('NFKC').toLowerCase();
const normSpace  = (s) => clean(s).replace(/\s+/g, ' ').trim();
const charSet    = (s) => new Set(Array.from(clean(s).replace(/\s+/g, '')));

const jaccard = (A, B) => {
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
};

function score(q, c) {
  const Q = clean(q).trim();
  const C = clean(c).trim();
  if (Q && C && Q === C) return 1;                 // exact
  if (Q && C && (Q.includes(C) || C.includes(Q)))  // contains
    return 0.95;
  return jaccard(charSet(Q), charSet(C));          // char-level Jaccard (CJK-safe)
}

function detectLang(q) {
  const s = String(q || '');
  if (/[ぁ-ゔァ-ヴー]/.test(s)) return 'JA';
  if (/[\u4e00-\u9fff]/.test(s)) return 'ZH';
  if (/[a-zA-Z]/.test(s)) return 'EN';
  return 'KO';
}

function pickAnswer(entry, lang) {
  const ans = entry.answers || {};
  return ans[lang] || ans.KO || ans.EN || Object.values(ans)[0] || '';
}

/* -------------------------------------------------------------
 * Candidate builder (question + aliases + keywords_core + keywords_related)
 *  - 각 후보가 어디서 왔는지(from)도 같이 반환(디버그 도움)
 * ----------------------------------------------------------- */
function buildCandidates(faq) {
  const out = [];
  const pushAll = (arr, from) => {
    for (const v of (arr || [])) {
      if (!v) continue;
      out.push({ text: String(v), from });
    }
  };
  if (faq.question) out.push({ text: String(faq.question), from: 'question' });
  pushAll(faq.aliases,          'alias');
  pushAll(faq.keywords_core,    'core');
  pushAll(faq.keywords_related, 'related');
  return out;
}

function bestMatch(question, lang, threshold) {
  let best = { score: -1, entry: null, matched: '', matched_from: '' };
  for (const f of FAQS) {
    const cands = buildCandidates(f);
    for (const c of cands) {
      const sc = score(question, c.text);
      if (sc > best.score) best = { score: sc, entry: f, matched: c.text, matched_from: c.from };
    }
  }
  return best.score >= threshold ? best : null;
}

/* -------------------------------------------------------------
 * Handler
 * ----------------------------------------------------------- */
module.exports = async (req, res) => {
  try {
    // CORS
    setCors(res, req.headers.origin);
    if (req.method === 'OPTIONS') return res.status(204).end();

    // GET: status & quick test via query (?q=...&diag=1)
    if (req.method === 'GET') {
      let qRaw = '';
      let diag = '';
      try {
        if (req.query) {
          qRaw = req.query.q || '';
          diag = req.query.diag || '';
        } else {
          const u = new URL(req.url, 'http://localhost');
          qRaw = u.searchParams.get('q') || '';
          diag = u.searchParams.get('diag') || '';
        }
      } catch {}

      // 한글/멀티바이트 안전 디코드 (이미 디코딩된 문자열이어도 try/catch로 안전)
      let question = qRaw;
      try { question = decodeURIComponent(qRaw); } catch {}

      let debug = null;
      if (question) {
        const bm = bestMatch(question, detectLang(question), 0);
        if (bm) {
          debug = {
            score: +bm.score.toFixed(3),
            matched: bm.matched,
            matched_from: bm.matched_from,
            id: bm.entry.id,
            url: bm.entry.url || null,
            url_title: bm.entry.url_title || null,
          };
          if (diag === '1') {
            debug.details = {
              Q_raw: question,
              C_raw: String(bm.matched || ''),
              candidates_preview: buildCandidates(bm.entry).slice(0, 8)
            };
          }
        }
      }

      return res.status(200).json({
        ok: true,
        version: 'faq-api-only v1-revised',
        methods: ['GET', 'POST'],
        faqs_count: FAQS.length,
        sample: FAQS[0]?.question || null,
        debug,
      });
    }

    // POST: main FAQ lookup
    if (req.method === 'POST') {
      const body = req.body || {};
      const question = String(body.question || '').trim();

      if (!question) {
        return res.status(400).json({ ok: false, error: 'Missing "question"' });
      }

      const lang = (body.lang || detectLang(question)).toUpperCase();
      const threshold = Number(process.env.FAQ_THRESHOLD ?? 0.08);
      const match = bestMatch(question, lang, threshold);

      if (!match) {
        return res.status(200).json({
          ok: true,
          lang,
          match: null,
          answer: '등록된 FAQ를 찾지 못했습니다.',
        });
      }

      // URL / Title (양쪽 키로 모두 제공: url/url_title + answer_url/answer_title)
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
        url,
        url_title,
        // 호환용(프론트가 answer_url/answer_title을 기대하는 경우도 지원)
        answer_url: url,
        answer_title: url_title,
        sources, // SHOW_SOURCE_CHIPS=true 시 칩으로 노출 가능
      });
    }

    // others
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  } catch (e) {
    console.error('Server Error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'Server Error' });
  }
};
