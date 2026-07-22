const https=require('https');const fs=require('fs');
function get(u){return new Promise((res,rej)=>{https.get(u,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(d));}).on('error',rej);});}
(async()=>{
  const base='https://familista-backend.onrender.com';
  const js=await get(base+'/app.js'), css=await get(base+'/app.css');
  const a=js.indexOf('function _sqSubHtml'),b=js.indexOf('function renderClubHome() {',a);const slice=js.slice(a,b);
  const page=`<!doctype html><html><head><meta charset="utf-8"><style>${css}
  *{box-sizing:border-box}body{margin:0;background:#0a0e1a;}#shell{display:flex;height:100vh}#side{width:224px;background:#0d1320;flex-shrink:0}#main{flex:1;min-width:0;display:flex;flex-direction:column;height:100vh}#subhd{height:84px;flex:0 0 auto;border-bottom:1px solid rgba(255,255,255,.06);display:flex;align-items:flex-end;padding:0 32px 12px;color:#8a94a6;font:600 13px Inter}#body{flex:1;min-height:0;overflow-y:auto}</style></head><body><div id="shell"><div id="side"></div><div id="main"><div id="subhd">Squad · Formation</div><div id="body"><div id="sq-sub-formation"></div></div></div></div>
  <script>var localStorage=window.localStorage;window.State={club:{name:'FC Familista'}};${slice}
  try{_sqBuildBoard();}catch(e){console.error(e);}
  function _render(){document.getElementById('sq-sub-formation').innerHTML=_sqFormationBody();}
  window.LIVE={render:_render,
    base:function(){return {opp:_sqTeamReport('opp'), my:_sqTeamReport('my'), mu:_sqMatchup(), benchChips:document.querySelectorAll('.sqmd-bench-chip[data-sub-opp]').length, oppTargets:document.querySelectorAll('.sqmd-card[data-team="opp"]').length, myTargets:document.querySelectorAll('.sqmd-card[data-team="my"]').length};},
    oppSubWeak:function(){ var bO=_sqTeamReport('opp'),muB=_sqMatchup(); _sqOppSubstitute('opr-7','op-10'); _render(); var aO=_sqTeamReport('opp'),muA=_sqMatchup(); return {nowStarter:_sqOppXi().some(function(p){return p.id==='opr-7';}), onBench:document.querySelectorAll('.sqmd-bench-chip[data-sub-opp="op-10"]').length, teamOvr:bO.ovr+'->'+aO.ovr, bal:bO.balance+'%->'+aO.balance+'%', xiOvr:bO.xiOvr+'->'+aO.xiOvr, benchOvr:bO.benchOvr+'->'+aO.benchOvr, compat:bO.compat+'%->'+aO.compat+'%', formEff:bO.formEff+'%->'+aO.formEff+'%', matchup:muB.matchup+'%->'+muA.matchup+'%', tacAdv:muB.tacAdv+'%->'+muA.tacAdv+'%'}; },
    mySubStillWorks:function(){ var benchId=SQ_BENCH_IDS[0]; var starter=SQ_MY_IDS[6]; var before=_sqMyStats(); _sqSubstitute(benchId,starter); _render(); var after=_sqMyStats(); return {benchNowStarter:SQ_MY_IDS.indexOf(benchId)>=0, ovr:before.ovr+'->'+after.ovr, bal:before.balance+'%->'+after.balance+'%'}; }
  };
  _render();</script></body></html>`;
  fs.writeFileSync('live_os.html',page);
  console.log('built. oppSubFn:', /_sqOppSubstitute/.test(slice), ' oppXi:', /_sqOppXi/.test(slice), ' oppReserve:', /SQ_OPP_RESERVE/.test(slice));
})();
