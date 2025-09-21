const fs = require('fs');
const path = require('path');
const FAQ_PATH = path.resolve(process.cwd(), 'data', 'faqs.json');
let FAQS = null;
function loadFaqs(){ if(!FAQS) FAQS = JSON.parse(fs.readFileSync(FAQ_PATH,'utf8')); return FAQS; }
function detectLang(q){ if(/[ぁ-ゔァ-ヴー]/.test(q)) return 'JA'; if(/[\u4e00-\u9fff]/.test(q)) return 'ZH'; if(/[a-zA-Z]/.test(q)) return 'EN'; return 'KO'; }
function norm(s){ return (s||'').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim(); }
function tokens(s){ return new Set(norm(s).split(' ').filter(Boolean)); }
function jaccard(a,b){ const A=tokens(a),B=tokens(b); if(!A.size||!B.size) return 0; let inter=0; for(const t of A) if(B.has(t)) inter++; return inter/(A.size+B.size-inter); }
function pickAnswer(entry,lang){ const ans=entry.answers||{}; return ans[lang]||ans.KO||ans.EN||Object.values(ans)[0]||''; }
function bestMatch(q,lang,th){ const qn=norm(q), faqs=loadFaqs(); let best={score:-1,entry:null,matched:''};
  for(const f of faqs){ for(const c of [f.question, ...(f.aliases||[])]){ const sc = qn===norm(c)?1:jaccard(qn,c); if(sc>best.score) best={score:sc,entry:f,matched:c}; } }
  return best.score>=th ? best : null;
}
module.exports = async (req,res)=>{
  try{
    if(req.method==='GET') return res.status(200).json({ok:true,version:'faq-api-only v1',methods:['GET','POST']});
    if(req.method!=='POST') return res.status(405).json({ok:false,error:'Method Not Allowed'});
    const body=req.body||{}; const question=String(body.question||'').trim(); if(!question) return res.status(400).json({ok:false,error:'Missing "question"'});
    const lang=(body.lang||detectLang(question)).toUpperCase();
    const threshold=Math.max(0,Math.min(1,Number(process.env.FAQ_THRESHOLD)||0.08));
    const match=bestMatch(question,lang,threshold);
    if(!match) return res.status(200).json({ok:true,lang,match:null,answer:'등록된 FAQ를 찾지 못했습니다.'});
    return res.status(200).json({ok:true,lang,match:{id:match.entry.id,question:match.entry.question,matched:match.matched,score:Number(match.score.toFixed(3))},answer:pickAnswer(match.entry,lang)});
  }catch(e){ return res.status(500).json({ok:false,error:e.message||'Server Error'}); }
};
