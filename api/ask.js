// api/ask.js
const fs = require('fs');
const path = require('path');

/**
 * ----------------------------------------------------------------
 * Load FAQs (Simplified and robust for Vercel)
 * ----------------------------------------------------------------
 */
// 서버가 시작될 때 한 번만 파일을 읽어 메모리에 저장해 둡니다. (효율성)
const FAQS = (() => {
  try {
    // Vercel 환경에서 가장 안정적인 파일 경로를 사용합니다.
    const filePath = path.resolve(__dirname, '..', 'data', 'faqs.json');
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error('Failed to load faqs.json:', error);
    return []; // 파일 로딩 실패 시 빈 배열을 반환하여 서버가 죽는 것을 방지
  }
})();

/**
 * ----------------------------------------------------------------
 * Text utils (handle invisible chars, normalize, tokenization)
 * ----------------------------------------------------------------
 */
const stripInvis = (s) => String(s ?? '').replace(/[\u200B-\u200D\uFEFF]/g, ''); // ZWSP/ZWNJ/ZWJ/BOM
const clean = (s) => stripInvis(String(s ?? '')).normalize('NFKC').toLowerCase();
const normSpace = (s) => clean(s).replace(/\s+/g, ' ').trim(); // for display

const charSet = (s) =>
  new Set(Array.from(clean(s).replace(/\s+/g, ''))); // character-level tokens (space removed)

const jaccard = (A, B) => {
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
};

function score(q, c) {
  const Q = clean(q).trim();
  const C = clean(c).trim();
  if (Q && C && Q === C) return 1; // 1) exact match
  if (Q && C && (Q.includes(C) || C.includes(Q))) return 0.95; // 2) contains
  return jaccard(charSet(Q), charSet(C)); // 3) character-level Jaccard
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

/**
 * ----------------------------------------------------------------
 * Handler
 * ----------------------------------------------------------------
 */
module.exports = async (req, res) => {
  try {
    // [GET 요청 처리] - 상태 확인 및 간단한 질문 테스트용
    if (req.method === 'GET') {
      // ★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★
      // ★ 여기가 핵심 수정사항입니다! 한글이 깨지지 않도록 decodeURIComponent를 사용합니다.
      // ★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★
      const question = decodeURIComponent(req.query.q || '');
      const diag = req.query.diag;
      let debug = null;

      if (question) {
        const bm = bestMatch(question, detectLang(question), 0);
        if (bm) {
          debug = { score: +bm.score.toFixed(3), matched: bm.matched, id: bm.entry.id };
          if (diag === '1') {
            const C_raw = String(bm.matched || '');
            debug.details = { Q_raw: question, C_raw: C_raw };
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

    // [POST 요청 처리] - 실제 챗봇 연동용
    if (req.method === 'POST') {
      const body = req.body || {};
      const question = String(body.question || '').trim();

      if (!question) {
        return res.status(400).json({ ok: false, error: 'Missing "question"' });
      }

      const lang = (body.lang || detectLang(question)).toUpperCase();
      const threshold = 0.08; // 매칭 점수 임계값
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

    // GET, POST가 아닌 다른 메소드는 허용 안함
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });

  } catch (e) {
    console.error('Server Error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'Server Error' });
  }
};