// api/ask.js
const fs = require('fs');
const path = require('path');

/* -------------------------------------------------------------
 * Load FAQs (robust path for Vercel; read once into memory)
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
 * ----------------------------------------------------------- */
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS ||
  'https://www.koreaferry.com,https://koreaferry.com,https://koreaferry.vercel.app,*'
).split(',').map(s => s.trim());

function setCors(res, origin) {
  const allow =
    ALLOW_ORIGINS.includes('*') ? '*' :
    (ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0]);
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

const charSet = (s) => new Set(Array.from(clean(s).replace(/\s+/g, '')));

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

function bestMatch(question, lang, threshold) {
  let best = { score: -1, entry: null, matched: '' };
  for (const f of FAQS) {
    const candidates = [f.question, ...(f.aliases || [])];
    for (const cand of candidates) {
      const sc = score(question, cand);
      if (sc > best.score) best = { score: sc, entry: f, matched: cand };
    }
  }
  return best.score >= threshold ? best : null;
}

/* -------------------------------------------------------------
 * Handler
 * ----------------------------------------------------------- */
module.exports = async (req, res) => {
  try {
    // CORS: preflight & headers
    setCors(res, req.headers.origin);
    if (req.method === 'OPTIONS') return res.status(204).end();

    // GET: status & quick test via query (?q=...&diag=1)
    if (req.method === 'GET') {
      // req.query 유무와 상관없이 안전하게 파싱
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

      // 한글이 깨지지 않도록, 이미 디코딩된 경우도 안전하게 처리
      let question = qRaw;
      try { question = decodeURIComponent(qRaw); } catch {}

      let debug = null;
      if (question) {
        const bm = bestMatch(question, detectLang(question), 0);
        if (bm) {
          debug = {
            score: +bm.score.toFixed(3),
            matched: bm.matched,
            id: bm.entry.id,
          };
          if (diag === '1') {
            debug.details = { Q_raw: question, C_raw: String(bm.matched || '') };
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

      return res.status(200).json({
        ok: true,
        lang,
        match: {
          id: match.entry.id,
          question: match.entry.question,
          matched: match.matched,
          score: +match.score.toFixed(3),
        },
        answer: pickAnswer(match.entry, lang),
      });
    }

    // others
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  } catch (e) {
    console.error('Server Error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'Server Error' });
  }
};
