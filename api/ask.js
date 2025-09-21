// api/ask.js
const fs = require('fs');
const path = require('path');

const FAQS = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'faqs.json'), 'utf8'));

// --- helpers (공백·대소문자만 정규화) ---
const norm = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const charSet = s => new Set(Array.from(String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '')));
const jaccard = (A,B)=>{ if(!A.size||!B.size) return 0; let inter=0; for(const t of A) if(B.has(t)) inter++; return inter/(A.size+B.size-inter); };
const detectLang = q => /[ぁ-ゔァ-ヴー]/.test(q)?'JA':/[\u4e00-\u9fff]/.test(q)?'ZH':/[a-zA-Z]/.test(q)?'EN':'KO';
const pickAnswer = (e,lang)=> (e.answers?.[lang] || e.answers?.KO || e.answers?.EN || Object.values(e.answers||{})[0] || '');

function score(q, c){
  const rq=String(q||'').trim(), rc=String(c||'').trim();
  const qn=norm(rq), cn=norm(rc);
  if ((rq&&rc&&rq===rc) || (qn&&cn&&qn===cn)) return 1;                 // 완전 일치
  if ((rq&&rc&&(rq.includes(rc)||rc.includes(rq))) ||                    // 부분 포함
      (qn&&cn&&(qn.includes(cn)||cn.includes(qn)))) return 0.95;
  return jaccard(charSet(rq), charSet(rc));                              // 문자 단위 자카드
}

function bestMatch(question, lang, threshold){
  let best={score:-1,entry:null,matched:''};
  for(const f of FAQS){
    for(const cand of [f.question, ...(f.aliases||[])]) {
      const sc = score(question, cand);
      if(sc>best.score) best={score:sc,entry:f,matched:cand};
    }
  }
  return best.score >= threshold ? best : null;
}

module.exports = async (req,res)=>{
  try{
    if(req.method==='GET'){
      let debug=null;
      try{
        const url=new URL(req.url,'http://localhost');
        const q=url.searchParams.get('q');
        if(q){ const bm=bestMatch(q, detectLang(q), 0); if(bm) debug={score:+bm.score.toFixed(3),matched:bm.matched,id:bm.entry.id}; }
      }catch{}
      return res.status(200).json({ ok
