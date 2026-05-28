// wednesday-scanner.mjs — delta check vs Sunday snapshot
import { getStore } from '@netlify/blobs';
import { fetchCBOE, fetchVIX, earningsGatePass } from './lib/cboe.mjs';

export default async (req) => {
  const headers={'Content-Type':'application/json'};
  const t0=Date.now();
  try {
    const store=getStore('trading-data');
    let snapshot=null;
    try{snapshot=await store.get('sunday-snapshot',{type:'json'});}catch{}

    const vix=await fetchVIX();
    const regime=vix==null?'UNKNOWN':vix<16?'RISK-ON':vix<25?'MIXED':'RISK-OFF';

    const MINI=[
      'NVDA','PLTR','TSLA','META','RDDT','MU','ALAB','COHR','AAOI','BE','GEV','NET',
      'MARA','SOFI','HOOD','COIN','IONQ','RGTI','BBAI','KTOS','RKLB','ASTS','AXON',
      'DOCN','APP','ACHR','JOBY','SOUN','PATH','SNAP','LYFT',
    ];
    const tickers=[...new Set([...(snapshot?.candidates||[]).map(c=>c.ticker),...MINI])];

    const results=[];
    for(let i=0;i<tickers.length;i+=10){
      const batch=tickers.slice(i,i+10);
      const f=await Promise.all(batch.map(t=>fetchCBOE(t)));
      results.push(...f.filter(Boolean));
    }

    const ACCOUNT_BALANCE=parseFloat(Netlify.env.get('ACCOUNT_BALANCE')||'15000');
    const IO_FUND_VETO=(Netlify.env.get('IO_FUND_VETO_LIST')||'AMD,AVGO,LITE').split(',').map(t=>t.trim().toUpperCase());
    const earningsBlocked=[];
    const current=[];

    for(const td of results){
      if(IO_FUND_VETO.includes(td.ticker)) continue;
      if(td.earnings?.hasEarnings) earningsBlocked.push({ticker:td.ticker,warning:td.earnings.warning});
      // Simple score for delta
      if(td.iv30>=50 && td.price*100<=ACCOUNT_BALANCE*0.15){
        const exps=[...new Set(td.options.map(o=>o.expiration))].sort();
        const today=new Date();
        const nearExp=exps.find(e=>{const d=(new Date(e)-today)/86400000;return d>=18&&d<=38;})||exps[0];
        if(nearExp){
          const dte=Math.max(1,(new Date(nearExp)-today)/86400000);
          const eg=earningsGatePass(td.earnings,Math.round(dte));
          if(eg.pass!==false){
            const puts=td.options.filter(o=>o.expiration===nearExp&&o.option_type==='P'&&o.strike_price<=td.price*0.96&&o.strike_price>=td.price*0.80);
            const atm=puts.filter(p=>p.strike_price<=td.price).sort((a,b)=>b.strike_price-a.strike_price)[0];
            if(atm){
              const mid=((atm.bid||0)+(atm.ask||0))/2;
              if(mid>0){
                const pctOTM=(td.price-atm.strike_price)/td.price*100;
                const ann=(mid/atm.strike_price)*(365/dte)*100;
                const score=td.iv30*0.35+Math.min(pctOTM*4,24)*0.30+Math.min((atm.open_interest||0)/1000,15)*1.5;
                current.push({ticker:td.ticker,strategy:'CSP',price:td.price,iv30:td.iv30.toFixed(1),score:score.toFixed(1),confidence:td.iv30>=80?'HIGH':td.iv30>=60?'MEDIUM':'LOW',nearExpiry:nearExp,dte:Math.round(dte),suggestedStrike:atm.strike_price,mid:mid.toFixed(2),pctOTM:pctOTM.toFixed(1),earningsWarning:eg.pass==='warn'?eg.reason:null});
              }
            }
          }
        }
      }
    }

    current.sort((a,b)=>parseFloat(b.score)-parseFloat(a.score));
    const sundaySet=new Set((snapshot?.candidates||[]).map(c=>`${c.ticker}-${c.strategy}`));
    const newEntries=current.filter(c=>!sundaySet.has(`${c.ticker}-${c.strategy}`));
    const dropped=(snapshot?.candidates||[]).filter(c=>!new Set(current.map(x=>`${x.ticker}-${x.strategy}`)).has(`${c.ticker}-${c.strategy}`));

    const result={ok:true,generatedAt:new Date().toISOString(),type:'wednesday-delta',vix:vix?.toFixed(2)??null,regime,candidateCount:current.length,currentTop10:current.slice(0,10),newEntries:newEntries.slice(0,5),droppedEntries:dropped.slice(0,5),earningsBlocked,durationMs:Date.now()-t0};
    await store.setJSON('latest-scan',result);

    const botToken=Netlify.env.get('TELEGRAM_BOT_TOKEN');const chatId=Netlify.env.get('TELEGRAM_CHAT_ID');
    if(botToken&&chatId){
      let msg=`📅 <b>Wednesday Scan</b> — ${new Date().toISOString().slice(0,10)}\nVIX: ${vix?.toFixed(1)??'?'} | Regime: <b>${regime}</b>\n<b>${current.length} candidates</b>`;
      if(earningsBlocked.length>0) msg+=`\n🚫 Earnings-blocked: ${earningsBlocked.map(e=>e.ticker).join(', ')}`;
      if(newEntries.length>0){msg+='\n\n<b>🆕 New:</b>\n';for(const c of newEntries.slice(0,3))msg+=`📉 <b>${c.ticker}</b> CSP [${c.confidence}] — ${c.mid} | ${c.pctOTM}% OTM\n`;}
      msg+='\n<b>Top 3:</b>\n';for(const c of current.slice(0,3))msg+=`📉 <b>${c.ticker}</b> $${c.suggestedStrike}P ${c.nearExpiry} score ${c.score}\n`;
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chatId,text:msg,parse_mode:'HTML'})});
    }
    return new Response(JSON.stringify(result),{status:200,headers});
  } catch(err){return new Response(JSON.stringify({ok:false,error:err.message}),{status:500,headers});}
};
export const config = { path: '/api/run-wednesday-scan' };
