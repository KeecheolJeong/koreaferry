// api/ask.js
// Vercel Serverless (Node) — CORS + 언어감지(ja 오인 방지) + zh 간/번체 정규화 + 혼합 스키마 지원
const fs = require('fs');
const path = require('path');

/* -------------------------------------------------------------
 * Load FAQs once (Vercel 런타임에서 안전한 경로)
 *  - 현재 레포 구조: /data/faqs.json (권장)
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
 * CORS (for WordPress widget, etc.)
 *  - env ALLOW_ORIGINS: comma separated origins, default "*"
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
  // JSON 명시
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
}

/* -------------------------------------------------------------
 * Matching config (짧은 질의 오탐 방지용)
 * ----------------------------------------------------------- */
// 하한선(환경변수로 조절): 너무 낮게 두면 오탐 증가
const HARD_MIN = Number(process.env.FAQ_HARD_MIN ?? 0.30);  // 권장 0.30
// 기본 임계값(길이가 충분한 질의의 베이스라인)
const DEFAULT_THRESHOLD = Number(process.env.FAQ_THRESHOLD ?? 0.30);
// 너무 짧은 질의 차단
const MIN_QUERY_CHARS = Number(process.env.FAQ_MIN_QUERY_CHARS ?? 2);

/* -------------------------------------------------------------
 * Text utils / scoring
 * ----------------------------------------------------------- */
const stripInvis = (s) => String(s ?? '').replace(/[\u200B-\u200D\uFEFF]/g, ''); // ZWSP/ZWNJ/ZWJ/BOM
const clean      = (s) => stripInvis(String(s ?? '')).normalize('NFKC').toLowerCase();
const noSpace    = (s) => clean(s).replace(/\s+/g, '');

const charSet = (s) => new Set(Array.from(noSpace(s)));

// CJK-safe bigrams (연속 2글자 토큰)
function bigramSet(s) {
  const t = noSpace(s);
  const out = new Set();
  if (t.length < 2) return out;
  for (let i = 0; i < t.length - 1; i++) {
    out.add(t[i] + t[i + 1]);
  }
  return out;
}

function jaccardSets(A, B) {
  if (!A.size || !B.size) return { score: 0, inter: 0 };
  let inter = 0;
  for (const v of A) if (B.has(v)) inter++;
  const score = inter / (A.size + B.size - inter);
  return { score, inter };
}

// 동적 임계값: 짧을수록 엄격
function dynamicThreshold(q) {
  const n = noSpace(q).length;
  if (n <= 1) return 1.0;   // 사실상 차단
  if (n === 2) return 0.98; // 거의 exact/contains만 통과
  if (n === 3) return 0.60;
  if (n <= 5) return 0.40;
  return DEFAULT_THRESHOLD;  // 6+ 글자
}

function score(q, c) {
  const Q = noSpace(q);
  const C = noSpace(c);
  if (!Q || !C) return 0;

  // 1) exact
  if (Q === C) return 1.0;

  // 2) contains (양방향)
  if (Q.includes(C) || C.includes(Q)) return 0.98;

  // 3) bigram 유사도
  const QB = bigramSet(Q), CB = bigramSet(C);
  if (QB.size && CB.size) {
    const { score } = jaccardSets(QB, CB);
    if (score > 0) return score;
  }

  // 4) char-level Jaccard
  const QC = charSet(Q), CC = charSet(C);
  const { score } = jaccardSets(QC, CC);
  return score;
}

/* -------------------------------------------------------------
 * 언어 태그 정규화 (zh_tw/zh_cn 포함)
 * ----------------------------------------------------------- */
function normalizeLangTag(tagRaw) {
  const t = String(tagRaw || '').toLowerCase().replace('_','-').trim();
  if (!t) return '';

  // 중국어 지역/별칭 → 표준화
  if (t === 'zh' || t.startsWith('zh-')) {
    // 번체(대만/홍콩/마카오)
    if (t.includes('tw') || t.includes('hk') || t.includes('mo') || t.includes('hant')) return 'zh-hant';
    // 간체(중국/싱가포르)
    if (t.includes('cn') || t.includes('sg') || t.includes('hans')) return 'zh-hans';
    // 모호한 zh → 간체 기본
    return 'zh-hans';
  }

  // 축약 별칭도 처리
  if (t === 'zh_tw' || t === 'zhtw') return 'zh-hant';
  if (t === 'zh_cn' || t === 'zhcn') return 'zh-hans';

  // 기본 언어
  if (t.startsWith('ko')) return 'ko';
  if (t.startsWith('ja')) return 'ja';
  if (t.startsWith('en')) return 'en';

  return t;
}

/* -------------------------------------------------------------
 * (B) 언어 감지 / 답변 선택 — 일본어 오인 방지 + zh 간/번체 지원
 * ----------------------------------------------------------- */
function detectLang(q, req) {
  // 1) lang 파라미터/바디 우선
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.searchParams.get('lang') || (req.body && req.body.lang);
    if (p && String(p).toLowerCase() !== 'auto') return normalizeLangTag(p);
  } catch {}

  // 2) 브라우저 수락언어
  const accept = String(req.headers['accept-language'] || '').toLowerCase();
  if (accept.startsWith('ja')) return 'ja';
  if (accept.startsWith('ko')) return 'ko';
  if (accept.startsWith('zh')) return normalizeLangTag(accept.split(',')[0]); // zh-CN/zh-TW 등

  // 3) 스크립트 휴리스틱
  const s = String(q || '');
  const hasHira = /[\u3040-\u309F]/.test(s);
  const hasKata = /[\u30A0-\u30FF\uFF66-\uFF9F]/.test(s);
  const hasHangul = /[\uAC00-\uD7AF]/.test(s);
  const hasHan = /[\u4E00-\u9FFF]/.test(s);

  if (hasHangul) return 'ko';
  if (hasHira || hasKata) return 'ja';
  if (hasHan) {
    // 일본어 힌트 문자(の/円/です/ください 등) 보이면 JA로
    const jaHints = /[の・〜～円様さんですますください頂き]/.test(s);
    return jaHints ? 'ja' : 'zh-hans'; // 모호하면 간체 기본
  }
  return 'en';
}

function pickAnswer(entry, langInput) {
  // ko / ja / en / zh-hans / zh-hant
  const lang = normalizeLangTag(langInput || '');

  // 1) 권장 스키마: answers.{ko,ja,zh,zh-Hans,zh-Hant,en,zh_tw,zh_cn ...}
  const ans = (entry.answers && typeof entry.answers === 'object') ? entry.answers : null;
  if (ans) {
    // 키 정규화: 소문자, '_'→'-'
    const normAns = {};
    for (const [k, v] of Object.entries(ans)) {
      const kk = String(k).toLowerCase().replace('_','-');
      normAns[kk] = v;
      // 별칭 보정: zh-tw → zh-hant, zh-cn → zh-hans
      if (kk === 'zh-tw') normAns['zh-hant'] = v;
      if (kk === 'zh-cn') normAns['zh-hans'] = v;
    }

    // 지정 언어 우선
    if (lang === 'zh-hant') {
      return normAns['zh-hant'] || normAns['zh'] || normAns['zh-hans'] || '';
    }
    if (lang === 'zh-hans') {
      return normAns['zh-hans'] || normAns['zh'] || normAns['zh-hant'] || '';
    }
    if (normAns[lang]) return normAns[lang];

    // 일반 폴백 순서
    for (const k of ['ko','ja','zh-hant','zh-hans','zh','en']) {
      if (normAns[k]) return normAns[k];
    }
  }

  // 2) 과거형 언더스코어 지원 (ko/ja/zh/en)
  const map = { 'ko':'answer_ko', 'ja':'answer_ja', 'zh-hans':'answer_zh', 'zh-hant':'answer_zh', 'en':'answer_en' };
  const altKey = map[lang];
  if (altKey && typeof entry[altKey] === 'string' && entry[altKey]) return entry[altKey];

  // 3) 단일 answer
  if (typeof entry.answer === 'string' && entry.answer) return entry.answer;

  // 4) 최후 폴백
  for (const k of ['answer_ko','answer_ja','answer_zh','answer_en']) {
    if (typeof entry[k] === 'string' && entry[k]) return entry[k];
  }
  return '';
}

/* -------------------------------------------------------------
 * 후보 생성 (question + aliases + keywords_core + keywords_related)
 * ----------------------------------------------------------- */
function buildCandidates(faq) {
  const out = [];
  const seen = new Set();
  const push = (text, from) => {
    const t = String(text || '');
    if (!t) return;
    const key = `${from}::${t}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ text: t, from });
  };

  if (faq.question) push(faq.question, 'question');
  for (const v of (faq.aliases || []))          push(v, 'alias');
  for (const v of (faq.keywords_core || []))    push(v, 'core');
  for (const v of (faq.keywords_related || [])) push(v, 'related');

  return out;
}

/* -------------------------------------------------------------
 * Best match with strong guard
 *   - very short queries => high threshold
 *   - floor with HARD_MIN
 * ----------------------------------------------------------- */
function bestMatch(question, lang, baseThreshold = DEFAULT_THRESHOLD) {
  const q = String(question || '').trim();
  const qlen = noSpace(q).length;
  if (qlen < MIN_QUERY_CHARS) return null;

  const dynT = dynamicThreshold(q);
  const threshold = Math.max(dynT, HARD_MIN, baseThreshold);

  let best = { score: -1, entry: null, matched: '', matched_from: '' };
  for (const f of FAQS) {
    const cands = buildCandidates(f);
    for (const c of cands) {
      const sc = score(q, c.text);
      if (sc > best.score) {
        best = { score: sc, entry: f, matched: c.text, matched_from: c.from };
      }
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

    /* ---------------------------------------------------------
     * GET: 상태 or 답변 (q 있으면 바로 검색/응답)
     * ------------------------------------------------------- */
    if (req.method === 'GET') {
      let qRaw = '', diag = '';
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

      // q가 없으면 상태만 반환
      if (!qRaw) {
        return res.status(200).json({
          ok: true,
          version: 'faq-api-only v1-strong',
          methods: ['GET', 'POST'],
          faqs_count: FAQS.length,
          sample: FAQS[0]?.question || null
        });
      }

      // 안전 디코드 + 검색
      let question = qRaw;
      try { question = decodeURIComponent(qRaw); } catch {}
      const lang = detectLang(question, req);
      const baseT = Number(process.env.FAQ_THRESHOLD ?? DEFAULT_THRESHOLD);
      const match = bestMatch(question, lang, baseT);

      if (!match) {
        const msg =
          lang === 'ja'
            ? '関連するご案内が見つかりませんでした。営業時間内にチャット/電話でお問い合わせください。'
            : (String(lang).startsWith('zh')
              ? '未找到相关指引。请在营业时间通过聊天或电话咨询。'
              : '관련 안내를 찾지 못했습니다. 영업시간 내 채팅/전화로 문의해 주세요.');
        return res.status(200).json({ ok: true, lang, match: null, answer: msg });
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
        url,
        url_title,
        answer_url: url,
        answer_title: url_title,
        sources,
      });
    }

    /* ---------------------------------------------------------
     * POST: main FAQ lookup (질문 본문 + 선택 언어)
     * ------------------------------------------------------- */
    if (req.method === 'POST') {
      const body = req.body || {};
      const question = String(body.question || '').trim();

      if (!question) {
        return res.status(400).json({ ok: false, error: 'Missing "question"' });
      }

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
        url,
        url_title,
        answer_url: url,
        answer_title: url_title,
        sources,
      });
    }

    // others
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  } catch (e) {
    console.error('Server Error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'Server Error' });
  }
};
