// api/ask.js — Minimal Stable v1
// 특징: 견고한 GET/POST 파싱, BOM-safe JSON 로드, 언어 태그 정규화(ko/ja/en/zh-hans/zh-hant),
//       answers 키 자동 매핑(KO/JA/ZH/EN/zh_tw 등), 1글자 exact 허용, exact 우선

const fs = require('fs');
const path = require('path');

/* ===== FAQs 로더 (BOM 제거 + 다중 경로 후보) ===== */
function safeLoadJson(p) {
  try {
    let raw = fs.readFileSync(p, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // BOM strip
    return JSON.parse(raw);
  } catch (e) {
    console.error('[ask] JSON load fail:', p, '-', e && e.message);
    return null;
  }
}
let FAQS = (() => {
  const candidates = [
    path.join(__dirname, 'faqs.json'),
    path.join(process.cwd(), 'api', 'faqs.json')
  ];
  for (const p of candidates) {
    const d = safeLoadJson(p);
    if (Array.isArray(d)) {
      console.log('[ask] Loaded FAQs from', p, 'items:', d.length);
      return d;
    }
  }
  console.error('[ask] Failed to load faqs.json');
  return [];
})();

/* ===== CORS ===== */
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || '*').split(',').map(s => s.trim());
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

/* ===== 유틸 (정규화/스코어) ===== */
const stripInvis = s => String(s ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '');
const clean      = s => stripInvis(String(s ?? '')).normalize('NFKC').toLowerCase();
const noSpace    = s => clean(s).replace(/\s+/g, '');
const charSet    = s => new Set(Array.from(noSpace(s)));
function bigramSet(s){const t=noSpace(s),o=new Set();if(t.length<2)return o;for(let i=0;i<t.length-1;i++)o.add(t[i]+t[i+1]);return o;}
function jaccard(A,B){if(!A.size||!B.size)return 0;let I=0;for(const v of A)if(B.has(v))I++;return I/(A.size+B.size-I);}

const HARD_MIN = Number(process.env.FAQ_HARD_MIN ?? 0.30);
const DEFAULT_THRESHOLD = Number(process.env.FAQ_THRESHOLD ?? 0.30);
const MIN_QUERY_CHARS = Number(process.env.FAQ_MIN_QUERY_CHARS ?? 2);

function dynamicThreshold(q){
  const n=noSpace(q).length;
  if(n<=1) return 1.0;
  if(n===2) return 0.98;
  if(n===3) return 0.60;
  if(n<=5) return 0.40;
  return DEFAULT_THRESHOLD;
}

function score(q,c){
  const Q=noSpace(q), C=noSpace(c);
  if(!Q||!C) return 0;
  if(Q===C) return 1.0;
  if(Q.includes(C)||C.includes(Q)) return 0.98;
  const s1=jaccard(bigramSet(Q),bigramSet(C)); if(s1>0) return s1;
  return jaccard(charSet(Q),charSet(C));
}

/* ===== 언어 태그 정규화 & 감지 ===== */
function normalizeLangTag(t){
  const s=String(t||'').toLowerCase().replace('_','-').trim();
  if(!s) return '';
  if(s==='zh'||s.startsWith('zh-')){
    if(s.includes('tw')||s.includes('hk')||s.includes('mo')||s.includes('hant')) return 'zh-hant';
    if(s.includes('cn')||s.includes('sg')||s.includes('hans')) return 'zh-hans';
    return 'zh-hans';
  }
  if(s==='zh_tw'||s==='zhtw') return 'zh-hant';
  if(s==='zh_cn'||s==='zhcn') return 'zh-hans';
  if(s.startsWith('ko')) return 'ko';
  if(s.startsWith('ja')) return 'ja';
  if(s.startsWith('en')) return 'en';
  return s;
}
function detectLang(q, req){
  try{
    const u=new URL(req.url, `http://${req.headers.host||'localhost'}`);
    const p=u.searchParams.get('lang') || (req.body && req.body.lang);
    if(p && String(p).toLowerCase()!=='auto') return normalizeLangTag(p);
  }catch{}
  const s=String(q||'');
  if(/[가-힣]/.test(s)) return 'ko';
  if(/[\u3040-\u309F\u30A0-\u30FF\uFF66-\uFF9F]/.test(s)) return 'ja';
  if(/[\u4E00-\u9FFF]/.test(s)) return 'zh-hans';
  if(/[a-zA-Z]/.test(s)) return 'en';
  return 'ko';
}

/* ===== answers 선택 (키 자동 매핑) ===== */
function pickAnswer(entry, langInput){
  const lang=normalizeLangTag(langInput||'');
  const ans = (entry.answers && typeof entry.answers==='object') ? entry.answers : null;
  if(ans){
    const m={};
    for(const [k,v] of Object.entries(ans)){
      const kk=String(k).toLowerCase().replace('_','-'); // ko/ja/en/zh/zh-tw/zh-cn...
      m[kk]=v;
      if(kk==='zh-tw') m['zh-hant']=v;
      if(kk==='zh-cn'||kk==='zh') m['zh-hans']=v;
    }
    if(lang==='zh-hant') return m['zh-hant']||m['zh-hans']||m['zh']||m['ko']||'';
    if(lang==='zh-hans') return m['zh-hans']||m['zh']||m['zh-hant']||m['ko']||'';
    if(m[lang]) return m[lang];
    for(const k of ['ko','ja','zh-hans','zh-hant','en']) if(m[k]) return m[k];
  }
  return entry.answer || entry.answer_ko || entry.answer_ja || entry.answer_zh || entry.answer_en || '';
}

/* ===== 후보 생성 & 매칭 ===== */
function buildCandidates(f){
  const out=[], seen=new Set();
  const push=(t,from)=>{t=String(t||''); if(!t) return; const key=from+'::'+t; if(seen.has(key)) return; seen.add(key); out.push({text:t,from});};
  if(f.question) push(f.question,'question');
  for(const v of (f.aliases||[]))          push(v,'alias');
  for(const v of (f.keywords_core||[]))    push(v,'core');
  for(const v of (f.keywords_related||[])) push(v,'related');
  return out;
}

function bestMatch(question, lang, baseT=DEFAULT_THRESHOLD){
  const q=String(question||'').trim();
  const qn=noSpace(q);

  // 1글자 exact 허용
  if(qn.length < MIN_QUERY_CHARS){
    for(const f of FAQS){
      for(const c of buildCandidates(f)){
        if(noSpace(c.text)===qn){
          return { score:1.0, entry:f, matched:c.text, matched_from:c.from };
        }
      }
    }
    return null;
  }

  const threshold=Math.max(dynamicThreshold(q), HARD_MIN, baseT);
  let best={score:-1, entry:null, matched:'', matched_from:''};
  for(const f of FAQS){
    for(const c of buildCandidates(f)){
      const cn=noSpace(c.text);
      if(cn && cn===qn){
        return { score:1.0, entry:f, matched:c.text, matched_from:c.from };
      }
      const sc=score(q,c.text);
      if(sc>best.score) best={score:sc, entry:f, matched:c.text, matched_from:c.from};
    }
  }
  return best.score>=threshold ? best : null;
}

/* ===== POST 바디 파서 ===== */
async function readJsonBody(req){
  try{
    if(req.body){
      if(typeof req.body==='string') return JSON.parse(req.body);
      if(typeof req.body==='object') return req.body;
    }
    const chunks=[]; for await(const ch of req) chunks.push(ch);
    const raw=Buffer.concat(chunks).toString('utf8');
    return raw ? JSON.parse(raw) : {};
  }catch{ return {}; }
}

/* ===== 핸들러 ===== */
module.exports = async (req, res) => {
  try{
    setCors(res, req.headers.origin);
    if(req.method==='OPTIONS') return res.status(204).end();

    if(req.method==='GET'){
      // URL 우선 파싱
      let qRaw='', diag='';
      try{
        const u=new URL(req.url, `http://${req.headers.host||'localhost'}`);
        qRaw=u.searchParams.get('q')||''; diag=u.searchParams.get('diag')||'';
      }catch{}
      if(req.query && typeof req.query==='object'){
        if(!qRaw && typeof req.query.q==='string') qRaw=req.query.q;
        if(!diag && typeof req.query.diag==='string') diag=req.query.diag;
      }

      if(!qRaw){
        return res.status(200).json({
          ok:true, version:'faq-api minimal v1', methods:['GET','POST'],
          faqs_count: FAQS.length, sample: FAQS[0]?.question || null
        });
      }

      let question=qRaw; try{ question=decodeURIComponent(qRaw); }catch{}
      let lang=detectLang(question, req);
      const match=bestMatch(question, lang, Number(process.env.FAQ_THRESHOLD ?? DEFAULT_THRESHOLD));

      if(!match){
        const fallback = lang==='ja'
          ? 'この質問は船社に電話でお問い合わせください。[電話番号]1688-7447'
          : (String(lang).startsWith('zh')
              ? '此问题请直接致电船公司咨询。[电话号码]1688-7447'
              : '이 질문은 선사에 전화문의 부탁드립니다. [전화번호]1688-7447');
        return res.status(200).json({ ok:true, lang, match:null, answer:fallback });
      }

      // URL 전달
      const url = match.entry.url || null;
      const url_title = match.entry.url_title || null;
      const sources = url ? [{ id: match.entry.id, url, title: url_title || url }] : undefined;

      return res.status(200).json({
        ok:true,
        lang,
        match:{
          id: match.entry.id,
          question: match.entry.question,
          matched: match.matched,
          matched_from: match.matched_from,
          score: +match.score.toFixed(3),
        },
        answer: pickAnswer(match.entry, lang),
        url, url_title,
        answer_url: url, answer_title: url_title,
        sources
      });
    }

    if(req.method==='POST'){
      const body=await readJsonBody(req);
      const question=String(body.question||'').trim();
      if(!question) return res.status(400).json({ ok:false, error:'Missing "question"' });

      let lang=normalizeLangTag(body.lang || detectLang(question, req));
      const match=bestMatch(question, lang, Number(process.env.FAQ_THRESHOLD ?? DEFAULT_THRESHOLD));

      if(!match){
        const fallback = lang==='ja'
          ? 'この質問は船社に電話でお問い合わせください。[電話番号]1688-7447'
          : (String(lang).startsWith('zh')
              ? '此问题请直接致电船公司咨询。[电话号码]1688-7447'
              : '이 질문은 선사에 전화문의 부탁드립니다. [전화번호]1688-7447');
        return res.status(200).json({ ok:true, lang, match:null, answer:fallback });
      }

      const url = match.entry.url || null;
      const url_title = match.entry.url_title || null;
      const sources = url ? [{ id: match.entry.id, url, title: url_title || url }] : undefined;

      return res.status(200).json({
        ok:true,
        lang,
        match:{
          id: match.entry.id,
          question: match.entry.question,
          matched: match.matched,
          matched_from: match.matched_from,
          score: +match.score.toFixed(3),
        },
        answer: pickAnswer(match.entry, lang),
        url, url_title,
        answer_url: url, answer_title: url_title,
        sources
      });
    }

    return res.status(405).json({ ok:false, error:'Method Not Allowed' });
  }catch(e){
    console.error('Server Error:', e);
    return res.status(500).json({ ok:false, error:e.message || 'Server Error' });
  }
};
