/**
 * OpenAlerts real-time monitoring dashboard.
 * Tabs: Activity (unified event + log timeline), System Logs, Health.
 * Activity shows both OpenAlerts engine events AND OpenClaw internal logs
 * grouped by sessionId for a complete picture of what's happening.
 */
export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenAlerts Monitor</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'SF Mono','Cascadia Code','Consolas',monospace;background:#0d1117;color:#c9d1d9;font-size:13px;overflow:hidden;height:100vh}
  .grid{display:grid;grid-template-rows:auto auto 1fr;height:100vh}

  /* ── Top bar ──────────────────── */
  .topbar{background:#161b22;border-bottom:1px solid #30363d;padding:8px 16px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
  .topbar h1{font-size:14px;font-weight:600;color:#f0f6fc;letter-spacing:0.5px}
  .dot{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:4px}
  .dot.live{background:#3fb950;animation:pulse 2s infinite}
  .dot.dead{background:#f85149}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
  .stat{color:#8b949e;font-size:11px}
  .stat b{color:#c9d1d9;font-weight:500}

  /* ── Tabs ──────────────────── */
  .tabbar{background:#161b22;border-bottom:1px solid #30363d;display:flex}
  .tab{padding:7px 18px;font-size:12px;font-weight:600;color:#8b949e;cursor:pointer;border-bottom:2px solid transparent;transition:all 0.15s}
  .tab:hover{color:#c9d1d9;background:#1c2129}
  .tab.active{color:#58a6ff;border-bottom-color:#58a6ff}
  .tab-content{display:none;overflow:hidden;flex:1}
  .tab-content.active{display:flex;overflow:hidden}
  .content{display:flex;flex-direction:column;overflow:hidden}

  /* ── Activity layout ──────────────────── */
  .activity-panels{display:grid;grid-template-columns:1fr 280px;gap:0;overflow:hidden;flex:1}
  @media(max-width:900px){.activity-panels{grid-template-columns:1fr}}
  .panel{display:flex;flex-direction:column;overflow:hidden}
  .panel-header{background:#161b22;padding:6px 12px;font-size:11px;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:0.8px;border-bottom:1px solid #30363d;flex-shrink:0;display:flex;align-items:center;justify-content:space-between}
  .panel:first-child{border-right:1px solid #30363d}
  .scroll{flex:1;overflow-y:auto}
  .scroll::-webkit-scrollbar{width:5px}
  .scroll::-webkit-scrollbar-thumb{background:#30363d;border-radius:3px}
  .empty-msg{color:#484f58;padding:30px 14px;text-align:center;font-style:italic;font-size:12px}

  /* ── Session flow (collapsible group) ──────────────────── */
  .flow{border-bottom:1px solid #21262d}
  .flow-hdr{padding:6px 10px;display:flex;align-items:center;gap:6px;cursor:pointer;font-size:11px;background:#161b22;border-left:3px solid #30363d;transition:all 0.12s}
  .flow-hdr:hover{background:#1c2129}
  .flow.active .flow-hdr{border-left-color:#58a6ff}
  .flow.done .flow-hdr{border-left-color:#3fb950}
  .flow.error .flow-hdr{border-left-color:#f85149}
  .flow-arr{color:#484f58;font-size:9px;width:12px;text-align:center;transition:transform 0.12s;flex-shrink:0}
  .flow-arr.shut{transform:rotate(-90deg)}
  .flow-lbl{font-weight:600;color:#c9d1d9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px}
  .flow-badge{font-size:9px;padding:1px 5px;border-radius:3px;font-weight:700;flex-shrink:0}
  .flow-badge.active{background:#1f3a5f;color:#58a6ff}
  .flow-badge.done{background:#1a3a2a;color:#3fb950}
  .flow-badge.error{background:#3d1a1a;color:#f85149}
  .flow-info{color:#484f58;font-size:10px;margin-left:auto;white-space:nowrap;flex-shrink:0}
  .flow-body{overflow:hidden;transition:max-height 0.2s ease-out}
  .flow-body.shut{max-height:0!important;overflow:hidden}

  /* ── Event/Log row ──────────────────── */
  .row{padding:3px 10px 3px 24px;border-top:1px solid #0d1117;font-size:11px;line-height:1.5;animation:fi 0.15s ease}
  .row:hover{background:#0d1117}
  .row.standalone{padding-left:10px;border-bottom:1px solid #21262d;border-top:none}
  .row.deep{padding-left:38px}

  /* OpenAlerts event row */
  .row .r-main{display:flex;align-items:center;gap:5px}
  .r-time{color:#484f58;font-size:10px;min-width:55px;flex-shrink:0}
  .r-icon{width:14px;text-align:center;flex-shrink:0;font-size:11px}
  .r-type{font-weight:600;min-width:90px;font-size:10px;flex-shrink:0}
  .r-type.llm{color:#58a6ff} .r-type.tool{color:#bc8cff} .r-type.agent{color:#3fb950}
  .r-type.session{color:#d29922} .r-type.infra{color:#f85149} .r-type.custom{color:#8b949e}
  .r-type.watchdog{color:#6e7681}
  .r-oc{font-size:9px;padding:0 4px;border-radius:3px;font-weight:700;flex-shrink:0}
  .r-oc.success{background:#1a3a2a;color:#3fb950}
  .r-oc.error{background:#3d1a1a;color:#f85149}
  .r-oc.timeout{background:#3d2e1a;color:#d29922}
  .r-pills{display:flex;gap:4px;flex-wrap:wrap;margin-left:auto;align-items:center}
  .p{font-size:9px;background:#21262d;padding:0 5px;border-radius:3px;white-space:nowrap}
  .p.t{color:#bc8cff;background:#2a1f3d} .p.d{color:#d29922} .p.tk{color:#58a6ff}
  .p.q{color:#f0883e} .p.m{color:#8b949e} .p.ch{color:#d2a8ff} .p.s{color:#6e7681;font-size:8px}
  .r-det{padding:1px 0 1px 70px;color:#6e7681;font-size:10px}
  .r-det .err{color:#f85149} .r-det .dim{color:#484f58} .r-det .sc{color:#d29922}

  /* OpenClaw log row */
  .row.log .r-main{display:flex;align-items:baseline;gap:5px}
  .r-lvl{font-size:9px;font-weight:700;min-width:38px;flex-shrink:0}
  .r-lvl.DEBUG{color:#6e7681} .r-lvl.INFO{color:#58a6ff} .r-lvl.WARN{color:#d29922} .r-lvl.ERROR{color:#f85149}
  .r-sub{color:#bc8cff;font-size:10px;min-width:100px;max-width:140px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .r-msg{color:#c9d1d9;font-size:11px;word-break:break-word}
  .r-kvs{color:#484f58;font-size:10px;padding-left:70px}
  .r-kvs span{margin-right:8px}

  @keyframes fi{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:none}}

  /* ── Alerts panel ──────────────────── */
  .al{padding:6px 10px;border-bottom:1px solid #21262d;font-size:11px;animation:fi 0.2s}
  .al-sev{font-weight:700;text-transform:uppercase;font-size:9px;letter-spacing:0.4px}
  .al-sev.error{color:#f85149} .al-sev.warn{color:#d29922} .al-sev.critical{color:#ff7b72} .al-sev.info{color:#58a6ff}
  .al-title{color:#c9d1d9;margin-top:1px;font-size:11px}
  .al-detail{color:#8b949e;margin-top:1px;font-size:10px}
  .al-time{color:#484f58;font-size:10px;margin-top:1px}

  /* ── Rules ──────────────────── */
  .rules{border-top:1px solid #30363d;padding:6px 10px;flex-shrink:0}
  .rules h3{font-size:10px;color:#8b949e;text-transform:uppercase;letter-spacing:0.7px;margin-bottom:4px}
  .rl{display:flex;align-items:center;gap:5px;font-size:11px;padding:1px 0}
  .rl-d{width:5px;height:5px;border-radius:50%;flex-shrink:0}
  .rl-d.ok{background:#3fb950} .rl-d.fired{background:#f85149;animation:pulse 1s infinite}
  .rl-s{color:#8b949e;margin-left:auto;font-size:10px}

  /* ── Logs tab ──────────────────── */
  .logs-t{flex:1;display:flex;flex-direction:column;overflow:hidden}
  .log-bar{background:#161b22;padding:5px 12px;border-bottom:1px solid #30363d;display:flex;align-items:center;gap:10px;flex-shrink:0;font-size:11px}
  .log-bar select,.log-bar input{background:#0d1117;border:1px solid #30363d;color:#c9d1d9;font-family:inherit;font-size:10px;padding:2px 6px;border-radius:3px}
  .log-bar button{background:#21262d;border:1px solid #30363d;color:#c9d1d9;font-family:inherit;font-size:10px;padding:2px 8px;border-radius:3px;cursor:pointer}
  .log-bar label{color:#8b949e}
  .log-list{flex:1;overflow-y:auto;font-size:11px}
  .log-e{padding:2px 12px;border-bottom:1px solid #161b22;display:flex;gap:6px;align-items:baseline}
  .log-e:hover{background:#161b22}
  .log-ts{color:#484f58;font-size:10px;min-width:70px;flex-shrink:0}
  .log-lv{font-size:9px;font-weight:700;min-width:42px;flex-shrink:0}
  .log-lv.DEBUG{color:#8b949e} .log-lv.INFO{color:#58a6ff} .log-lv.WARN{color:#d29922} .log-lv.ERROR{color:#f85149}
  .log-su{color:#bc8cff;font-size:10px;min-width:110px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .log-mg{color:#c9d1d9;word-break:break-all}

  /* ── Health tab ──────────────────── */
  .health-t{flex:1;overflow-y:auto;padding:14px}
  .h-sec{margin-bottom:16px}
  .h-sec h3{font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:0.7px;margin-bottom:6px;padding-bottom:3px;border-bottom:1px solid #21262d}
  .h-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:6px}
  .h-card{background:#161b22;border:1px solid #21262d;border-radius:5px;padding:8px 12px}
  .h-card .lb{color:#8b949e;font-size:10px;margin-bottom:2px}
  .h-card .vl{color:#c9d1d9;font-size:13px;font-weight:600}
  .h-card .vl.ok{color:#3fb950} .h-card .vl.bad{color:#f85149}
  .h-tbl{width:100%;border-collapse:collapse}
  .h-tbl td{padding:3px 8px;font-size:11px;border-bottom:1px solid #161b22}
  .h-tbl td:first-child{color:#8b949e;width:140px}
  .h-tbl th{padding:3px 8px;font-size:10px;color:#8b949e;text-align:left;border-bottom:1px solid #30363d;font-weight:600}

  /* ── Expandable event detail ──────────────────── */
  .row.expandable{cursor:pointer}
  .row.expandable:hover{background:#161b22}
  .ev-detail{background:#0d1117;border:1px solid #21262d;border-radius:4px;margin:4px 10px 6px 24px;padding:8px 10px;display:none;animation:fi 0.15s ease}
  .ev-detail.open{display:block}
  .ev-detail h4{font-size:10px;color:#58a6ff;text-transform:uppercase;letter-spacing:0.6px;margin:6px 0 3px;font-weight:600}
  .ev-detail h4:first-child{margin-top:0}
  .ev-detail .dv{display:flex;gap:4px;align-items:baseline;font-size:11px;padding:1px 0}
  .ev-detail .dk{color:#8b949e;min-width:90px;flex-shrink:0}
  .ev-detail .dd{color:#c9d1d9;word-break:break-all}
  .ev-detail .dd .cp-btn{font-size:9px;color:#484f58;cursor:pointer;margin-left:4px;border:1px solid #30363d;background:#161b22;padding:0 3px;border-radius:2px;font-family:inherit}
  .ev-detail .dd .cp-btn:hover{color:#c9d1d9;border-color:#484f58}
  .ev-detail .err-block{background:#1a0a0a;border:1px solid #3d1a1a;border-radius:3px;padding:6px 8px;color:#f85149;font-size:11px;max-height:120px;overflow-y:auto;white-space:pre-wrap;word-break:break-all}
  .ev-detail .meta-grid{display:grid;grid-template-columns:auto 1fr;gap:2px 8px;font-size:11px}
  .ev-detail .meta-grid .mk{color:#8b949e;text-align:right}
  .ev-detail .meta-grid .mv{color:#c9d1d9;word-break:break-all}

  /* Inline row indicators */
  .sev-dot{width:6px;height:6px;border-radius:50%;display:inline-block;flex-shrink:0}
  .sev-dot.info{background:#58a6ff} .sev-dot.warn{background:#d29922} .sev-dot.error{background:#f85149} .sev-dot.critical{background:#ff7b72}
  .p.cost{color:#3fb950;background:#1a3a2a} .p.agent{color:#d2a8ff;background:#2a1f3d}

  /* ── Flow summary bar ──────────────────── */
  .flow-summary{background:#0d1117;padding:4px 10px;font-size:10px;color:#8b949e;display:flex;flex-wrap:wrap;gap:4px 12px;border-bottom:1px solid #21262d;align-items:center}
  .flow-summary .fs-v{color:#c9d1d9;font-weight:600}
  .flow-summary .fs-err{color:#f85149;font-weight:600}
  .flow-summary .fs-tools{color:#bc8cff}
  .flow-summary .fs-agent{color:#d2a8ff}

  /* ── Expandable log row ──────────────────── */
  .log-e{cursor:pointer;transition:background 0.1s}
  .log-detail{display:none;background:#0d1117;border:1px solid #21262d;border-radius:3px;margin:2px 12px 4px 12px;padding:6px 8px;animation:fi 0.12s ease}
  .log-detail.open{display:block}
  .log-detail .ld-grid{display:grid;grid-template-columns:auto 1fr;gap:1px 8px;font-size:10px}
  .log-detail .ld-grid .lk{color:#8b949e;text-align:right}
  .log-detail .ld-grid .lv{color:#c9d1d9;word-break:break-all}
  .log-detail .ld-file{color:#484f58;font-size:10px;margin-top:3px}
</style>
</head>
<body>
<div class="grid">
  <div class="topbar">
    <h1><span class="dot dead" id="sDot"></span> OPENALERTS</h1>
    <span class="stat" id="sConn">connecting...</span>
    <span class="stat">up: <b id="sUp">--</b></span>
    <span class="stat">msgs: <b id="sMsgs">0</b></span>
    <span class="stat">err: <b id="sErr">0</b></span>
    <span class="stat">tools: <b id="sTools">0</b></span>
    <span class="stat">agents: <b id="sAgents">0</b></span>
  </div>
  <div class="tabbar">
    <div class="tab active" data-tab="activity">Activity</div>
    <div class="tab" data-tab="logs">System Logs</div>
    <div class="tab" data-tab="health">Health</div>
  </div>
  <div class="content">
    <!-- Activity -->
    <div class="tab-content active" id="tab-activity">
      <div class="activity-panels">
        <div class="panel">
          <div class="panel-header"><span>Live Timeline</span><span style="color:#484f58;font-weight:400" id="evCnt">0</span></div>
          <div class="scroll" id="evList"><div class="empty-msg" id="emptyMsg">Waiting for events... send a message to your bot.</div></div>
        </div>
        <div class="panel">
          <div class="panel-header">Alerts</div>
          <div class="scroll" id="alList"><div class="empty-msg" id="alEmpty">No alerts.</div></div>
          <div class="rules" id="rulesEl"><h3>Rules</h3></div>
        </div>
      </div>
    </div>
    <!-- System Logs -->
    <div class="tab-content" id="tab-logs">
      <div class="logs-t">
        <div class="log-bar">
          <label>Sub:</label>
          <select id="lF"><option value="">All</option></select>
          <label>Level:</label>
          <select id="lL"><option value="">All</option><option value="INFO">INFO+</option><option value="WARN">WARN+</option><option value="ERROR">ERROR</option></select>
          <input type="text" id="lS" placeholder="Search..." style="width:120px">
          <button id="lR">Refresh</button>
          <label style="margin-left:auto"><input type="checkbox" id="lA" checked> Auto</label>
        </div>
        <div class="log-list" id="logList"><div class="empty-msg">Loading...</div></div>
      </div>
    </div>
    <!-- Health -->
    <div class="tab-content" id="tab-health">
      <div class="health-t" id="hC"><div class="empty-msg">Loading...</div></div>
    </div>
  </div>
</div>
<script>
(function(){
  var MAX_FLOWS=150, MAX_STANDALONE=300, MAX_ALERTS=50, STALE_MS=120000;
  var total=0, paused=false, evSrc=null;
  var $=function(i){return document.getElementById(i)};
  var evList=$('evList'), emptyMsg=$('emptyMsg'), alList=$('alList'), alEmpty=$('alEmpty'), evCnt=$('evCnt');

  function esc(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML}
  function cat(t){if(!t)return'custom';var p=t.split('.')[0];return['llm','tool','agent','session','infra','watchdog'].indexOf(p)>=0?p:'custom'}
  function fT(ts){if(!ts)return'';var d=typeof ts==='number'?new Date(ts):new Date(ts);return d.toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'})}
  function fISO(ts){if(!ts)return'';return new Date(typeof ts==='number'?ts:Date.parse(ts)).toISOString()}
  function fD(ms){if(ms==null)return'';if(ms<1000)return ms+'ms';if(ms<60000)return(ms/1000).toFixed(1)+'s';return Math.floor(ms/60000)+'m '+Math.round((ms%60000)/1000)+'s'}
  function fU(ms){var s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60);return h>0?h+'h '+m%60+'m':m+'m '+s%60+'s'}
  function fAgo(ts){if(!ts)return'never';var d=Date.now()-ts;if(d<0)d=0;if(d<1000)return'just now';if(d<60000)return Math.floor(d/1000)+'s ago';if(d<3600000)return Math.floor(d/60000)+'m ago';return Math.floor(d/3600000)+'h ago'}

  /** Copy text to clipboard with visual feedback */
  function cpToClip(text,btn){
    navigator.clipboard.writeText(text).then(function(){
      var orig=btn.textContent;btn.textContent='\\u2713';setTimeout(function(){btn.textContent=orig},800);
    }).catch(function(){});
  }

  // ─── Subsystem label helpers ──────────────────────
  var subIcons={'diagnostic':'\\u2139','plugins':'\\u2699','agent/embedded':'\\u25B6','gateway':'\\u2302','gateway/ws':'\\u21C4','heartbeat':'\\u2764','canvas':'\\u25A1'};
  function subIcon(s){for(var k in subIcons)if(s.indexOf(k)>=0)return subIcons[k];return'\\u2022'}

  // ─── Flow tracker ──────────────────────
  var flows={}, flowOrd=[];

  function getFlow(sid,ev){
    if(flows[sid])return flows[sid];
    var c=document.createElement('div');c.className='flow active';
    var hdr=document.createElement('div');hdr.className='flow-hdr';
    var short=sid.length>20?sid.slice(0,8)+'..'+sid.slice(-4):sid;
    hdr.innerHTML='<span class="flow-arr">\\u25BC</span><span class="flow-lbl" title="'+esc(sid)+'">Session '+esc(short)+'</span><span class="flow-badge active" data-r="st">active</span><span class="flow-info" data-r="info">'+fT(ev.ts||ev.tsMs)+'</span>';
    var summary=document.createElement('div');summary.className='flow-summary';summary.setAttribute('data-r','summary');
    var body=document.createElement('div');body.className='flow-body';
    hdr.addEventListener('click',function(){
      var shut=!body.classList.contains('shut');
      body.classList.toggle('shut',shut);
      summary.style.display=shut?'none':'flex';
      hdr.querySelector('.flow-arr').classList.toggle('shut',shut);
    });
    c.appendChild(hdr);c.appendChild(summary);c.appendChild(body);
    var f={el:c,body:body,hdr:hdr,summary:summary,st:'active',n:0,startTs:Date.now(),sid:sid,err:false,errCount:0,dur:0,tok:0,cost:0,tools:0,llms:0,toolNames:{},agentId:''};
    flows[sid]=f;flowOrd.push(sid);
    emptyMsg.style.display='none';
    evList.insertBefore(c,evList.firstChild);
    return f;
  }

  function updFlow(f,st){
    f.st=st;f.el.className='flow '+st;
    var sEl=f.hdr.querySelector('[data-r="st"]');
    if(sEl){sEl.className='flow-badge '+st;sEl.textContent=st}
    var iEl=f.hdr.querySelector('[data-r="info"]');
    if(iEl){
      var ps=[f.n+' events'];
      if(f.dur>0)ps.push(fD(f.dur));
      if(f.tok>0)ps.push(f.tok+' tok');
      if(f.cost>0)ps.push('$'+f.cost.toFixed(4));
      if(f.tools>0)ps.push(f.tools+' tools');
      if(f.llms>0)ps.push(f.llms+' llm');
      iEl.textContent=ps.join(' \\u00B7 ');
    }
    // Update summary bar
    var sh='';
    sh+='<span>Events: <span class="fs-v">'+f.n+'</span></span>';
    if(f.dur>0)sh+='<span>Duration: <span class="fs-v">'+fD(f.dur)+'</span></span>';
    if(f.tok>0)sh+='<span>Tokens: <span class="fs-v">'+f.tok+'</span></span>';
    if(f.cost>0)sh+='<span>Cost: <span class="fs-v">$'+f.cost.toFixed(4)+'</span></span>';
    var tn=Object.keys(f.toolNames);
    if(tn.length)sh+='<span>Tools: <span class="fs-tools">'+tn.map(esc).join(', ')+'</span></span>';
    if(f.errCount>0)sh+='<span>Errors: <span class="fs-err">'+f.errCount+'</span></span>';
    if(f.agentId)sh+='<span>Agent: <span class="fs-agent">'+esc(f.agentId)+'</span></span>';
    f.summary.innerHTML=sh;
  }

  // ─── Build expandable event detail panel ──────────────────────
  function buildEvDetail(ev){
    var d=document.createElement('div');d.className='ev-detail';
    var m=ev.meta||{};
    var h='<h4>Identity</h4>';
    h+=dvRow('Type',ev.type||'?');
    h+=dvRow('Timestamp',fISO(ev.ts));
    if(ev.sessionKey)h+=dvRowCopy('Session Key',ev.sessionKey);
    if(ev.agentId)h+=dvRowCopy('Agent ID',ev.agentId);
    if(ev.channel)h+=dvRow('Channel',ev.channel);
    if(ev.outcome)h+=dvRow('Outcome',ev.outcome);
    if(ev.severity)h+=dvRow('Severity',ev.severity);

    var hasMetrics=ev.durationMs!=null||ev.tokenCount!=null||ev.costUsd!=null||ev.queueDepth!=null||ev.ageMs!=null;
    if(hasMetrics){
      h+='<h4>Metrics</h4>';
      if(ev.durationMs!=null)h+=dvRow('Duration',fD(ev.durationMs)+' ('+ev.durationMs+'ms)');
      if(ev.tokenCount!=null)h+=dvRow('Tokens',String(ev.tokenCount));
      if(ev.costUsd!=null)h+=dvRow('Cost','$'+ev.costUsd.toFixed(6));
      if(ev.queueDepth!=null)h+=dvRow('Queue Depth',String(ev.queueDepth));
      if(ev.ageMs!=null)h+=dvRow('Age',fD(ev.ageMs)+' ('+ev.ageMs+'ms)');
    }

    if(ev.error){
      h+='<h4>Error</h4>';
      h+='<div class="err-block">'+esc(ev.error)+'</div>';
    }

    var mKeys=Object.keys(m);
    if(mKeys.length){
      h+='<h4>Meta ('+mKeys.length+' fields)</h4>';
      h+='<div class="meta-grid">';
      for(var i=0;i<mKeys.length;i++){
        var k=mKeys[i],v=m[k];
        var vs=typeof v==='object'?JSON.stringify(v):String(v!=null?v:'');
        h+='<span class="mk">'+esc(k)+'</span><span class="mv">'+esc(vs)+'</span>';
      }
      h+='</div>';
    }

    d.innerHTML=h;
    // Wire up copy buttons after inserting
    setTimeout(function(){
      d.querySelectorAll('.cp-btn').forEach(function(btn){
        btn.addEventListener('click',function(e){e.stopPropagation();cpToClip(btn.getAttribute('data-cp'),btn)});
      });
    },0);
    return d;
  }

  function dvRow(label,val){return'<div class="dv"><span class="dk">'+esc(label)+'</span><span class="dd">'+esc(String(val))+'</span></div>'}
  function dvRowCopy(label,val){return'<div class="dv"><span class="dk">'+esc(label)+'</span><span class="dd">'+esc(String(val))+'<button class="cp-btn" data-cp="'+esc(String(val))+'">copy</button></span></div>'}

  // ─── Build an OpenAlerts event row ──────────────────────
  function buildEvRow(ev,depth){
    var wrap=document.createElement('div');
    var div=document.createElement('div');
    div.className='row expandable'+(depth===0?' standalone':depth>1?' deep':'');
    var c=cat(ev.type),oc=ev.outcome||'',m=ev.meta||{};
    var ft=ev.type||'?';
    if(ft==='custom'&&m.openclawEventType==='session.state')ft='session.'+(m.sessionState||'state');
    if(ft==='custom'&&m.openclawEventType==='message_sent')ft='msg.delivered';

    var h='<div class="r-main">';
    h+='<span class="r-time">'+fT(ev.ts)+'</span>';
    if(ev.severity)h+='<span class="sev-dot '+(ev.severity||'')+'" title="'+esc(ev.severity)+'"></span>';
    h+='<span class="r-type '+c+'">'+esc(ft)+'</span>';
    if(oc)h+='<span class="r-oc '+oc+'">'+(oc==='success'?'\\u2713':oc==='error'?'\\u2717':'\\u25CB')+' '+oc+'</span>';
    h+='<span class="r-pills">';
    if(m.toolName)h+='<span class="p t">'+esc(String(m.toolName))+'</span>';
    if(ev.durationMs!=null)h+='<span class="p d">'+fD(ev.durationMs)+'</span>';
    if(ev.tokenCount!=null)h+='<span class="p tk">'+ev.tokenCount+' tok</span>';
    if(ev.costUsd!=null)h+='<span class="p cost">$'+ev.costUsd.toFixed(4)+'</span>';
    if(ev.agentId)h+='<span class="p agent">'+esc(ev.agentId.length>12?ev.agentId.slice(0,8)+'..':ev.agentId)+'</span>';
    if(ev.queueDepth!=null)h+='<span class="p q">q='+ev.queueDepth+'</span>';
    if(m.model)h+='<span class="p m">'+esc(String(m.model))+'</span>';
    if(ev.channel)h+='<span class="p ch">'+esc(ev.channel)+'</span>';
    if(m.messageCount!=null)h+='<span class="p">'+m.messageCount+' msgs</span>';
    if(m.source&&String(m.source)!=='simulate')h+='<span class="p s">'+esc(String(m.source))+'</span>';
    h+='</span></div>';

    var ds=[];
    if(ev.error)ds.push('<span class="err">'+esc(ev.error.length>120?ev.error.slice(0,120)+'...':ev.error)+'</span>');
    if(ev.ageMs!=null)ds.push('stuck '+fD(ev.ageMs));
    if(m.sessionState)ds.push('<span class="sc">'+(m.previousState||'?')+' \\u2192 '+m.sessionState+'</span>');
    if(m.provider)ds.push('<span class="dim">provider: '+esc(String(m.provider))+'</span>');
    if(m.to)ds.push('<span class="dim">to: '+esc(String(m.to))+'</span>');
    if(ev.sessionKey&&depth===0)ds.push('<span class="dim">session: '+esc(ev.sessionKey.slice(0,12))+'</span>');
    if(ds.length)h+='<div class="r-det">'+ds.join(' \\u00B7 ')+'</div>';

    div.innerHTML=h;
    wrap.appendChild(div);

    // Click to expand/collapse detail panel
    var detail=buildEvDetail(ev);
    wrap.appendChild(detail);
    div.addEventListener('click',function(e){
      if(e.target.classList.contains('cp-btn'))return;
      detail.classList.toggle('open');
    });

    return wrap;
  }

  // ─── Build an OpenClaw log row (Activity tab) ──────────────────────
  function buildLogRow(entry,depth){
    var div=document.createElement('div');
    div.className='row log'+(depth===0?' standalone':depth>1?' deep':'');
    var h='<div class="r-main">';
    h+='<span class="r-time">'+fT(entry.tsMs||entry.ts)+'</span>';
    h+='<span class="r-lvl '+esc(entry.level)+'">'+esc(entry.level)+'</span>';
    h+='<span class="r-sub" title="'+esc(entry.subsystem)+'">'+subIcon(entry.subsystem)+' '+esc(entry.subsystem)+'</span>';
    h+='<span class="r-msg">'+esc(entry.message)+'</span>';
    h+='</div>';

    // Show ALL parsed key=value pairs
    var kvs=entry.extra||{};
    var kvKeys=Object.keys(kvs);
    if(kvKeys.length){
      var kvParts=[];
      for(var i=0;i<kvKeys.length;i++){
        var k=kvKeys[i],v=kvs[k];
        if(k==='sessionId'||k==='runId')kvParts.push('<span>'+esc(k)+'='+esc(v.length>16?v.slice(0,12)+'..':v)+'</span>');
        else if(k==='durationMs')kvParts.push('<span>duration='+fD(parseInt(v))+'</span>');
        else kvParts.push('<span>'+esc(k)+'='+esc(v)+'</span>');
      }
      if(kvParts.length)h+='<div class="r-kvs">'+kvParts.join('')+'</div>';
    }

    div.innerHTML=h;return div;
  }

  // ─── Ingest OpenAlerts event ──────────────────────
  function addEvent(ev){
    total++;evCnt.textContent=total;emptyMsg.style.display='none';
    if(paused)return;
    var sid=ev.sessionKey||ev.agentId;
    if(sid&&(flows[sid]||ev.type==='agent.start'||ev.type==='session.start'||ev.type==='custom')){
      var f=getFlow(sid,ev);f.n++;
      if(ev.tokenCount)f.tok+=ev.tokenCount;
      if(ev.costUsd)f.cost+=ev.costUsd;
      if(ev.agentId&&!f.agentId)f.agentId=ev.agentId;
      if(ev.type==='tool.call'||ev.type==='tool.error'){f.tools++;if(ev.meta&&ev.meta.toolName)f.toolNames[String(ev.meta.toolName)]=true}
      if(ev.type==='llm.call')f.llms++;
      if(ev.outcome==='error'){f.err=true;f.errCount++}
      var depth=1;
      if(ev.type==='tool.call'||ev.type==='tool.error'||ev.type==='llm.call'||ev.type==='llm.token_usage')depth=2;
      f.body.appendChild(buildEvRow(ev,depth));
      if(evList.firstChild!==f.el)evList.insertBefore(f.el,evList.firstChild);
      if(ev.type==='agent.end'||ev.type==='session.end'){if(ev.durationMs)f.dur=ev.durationMs;updFlow(f,f.err?'error':'done')}
      else if(ev.type==='agent.error'){f.err=true;f.errCount++;if(ev.durationMs)f.dur=ev.durationMs;updFlow(f,'error')}
      else updFlow(f,f.st);
      f.el.scrollIntoView({block:'nearest',behavior:'smooth'});
      return;
    }
    var row=buildEvRow(ev,0);
    if(evList.firstChild&&evList.firstChild!==emptyMsg)evList.insertBefore(row,evList.firstChild);
    else evList.appendChild(row);
    trimStandalone();
  }

  // ─── Ingest OpenClaw log entry (from log tailer) ──────────────────────
  function addLogEntry(entry){
    total++;evCnt.textContent=total;emptyMsg.style.display='none';
    if(paused)return;
    // Also stream to logs tab if active and auto-refresh is on
    if($('tab-logs').classList.contains('active')&&$('lA').checked){
      appendLogToTab(entry);
    }
    var sid=entry.sessionId;
    if(sid&&flows[sid]){
      var f=flows[sid];f.n++;
      f.body.appendChild(buildLogRow(entry,1));
      if(evList.firstChild!==f.el)evList.insertBefore(f.el,evList.firstChild);
      updFlow(f,f.st);
      f.el.scrollIntoView({block:'nearest',behavior:'smooth'});
      return;
    }
    if(sid){
      var f=getFlow(sid,entry);f.n++;
      f.body.appendChild(buildLogRow(entry,1));
      updFlow(f,f.st);
      f.el.scrollIntoView({block:'nearest',behavior:'smooth'});
      return;
    }
    var row=buildLogRow(entry,0);
    if(evList.firstChild&&evList.firstChild!==emptyMsg)evList.insertBefore(row,evList.firstChild);
    else evList.appendChild(row);
    trimStandalone();
  }

  function trimStandalone(){
    var all=evList.querySelectorAll('.row.standalone');
    while(all.length>MAX_STANDALONE){all[all.length-1].remove();all=evList.querySelectorAll('.row.standalone')}
  }

  // ─── Stale flow cleanup ──────────────────────
  setInterval(function(){
    var now=Date.now();
    for(var k in flows){
      var f=flows[k];
      if(f.st==='active'&&now-f.startTs>STALE_MS)updFlow(f,'done');
      if(f.st!=='active'&&now-f.startTs>600000){f.el.remove();delete flows[k];var i=flowOrd.indexOf(k);if(i>=0)flowOrd.splice(i,1)}
    }
    while(flowOrd.length>MAX_FLOWS){var old=flowOrd.shift();if(flows[old]){flows[old].el.remove();delete flows[old]}}
  },30000);

  // ─── Alerts ──────────────────────
  function addAlert(a){
    alEmpty.style.display='none';
    var d=document.createElement('div');d.className='al';
    d.innerHTML='<div class="al-sev '+(a.severity||'error')+'">['+((a.severity||'ERROR').toUpperCase())+'] '+esc(a.ruleId||'')+'</div><div class="al-title">'+esc(a.title||'')+'</div><div class="al-detail">'+esc(a.detail||'')+'</div><div class="al-time">'+fT(a.ts)+'</div>';
    alList.insertBefore(d,alList.firstChild);
    while(alList.children.length>MAX_ALERTS+1)alList.removeChild(alList.lastChild);
  }

  evList.addEventListener('mouseenter',function(){paused=true});
  evList.addEventListener('mouseleave',function(){paused=false});

  // ─── Tabs ──────────────────────
  document.querySelectorAll('.tab').forEach(function(t){
    t.addEventListener('click',function(){
      document.querySelectorAll('.tab').forEach(function(x){x.classList.remove('active')});
      document.querySelectorAll('.tab-content').forEach(function(x){x.classList.remove('active')});
      t.classList.add('active');
      var tgt=$('tab-'+t.dataset.tab);if(tgt)tgt.classList.add('active');
      if(t.dataset.tab==='logs')refreshLogs();
      if(t.dataset.tab==='health')refreshHealth();
    });
  });

  // ─── SSE (OpenAlerts events + OpenClaw log tailing) ──────────────────────
  function connectSSE(){
    if(evSrc)evSrc.close();
    evSrc=new EventSource('/openalerts/events');
    evSrc.addEventListener('openalerts',function(e){try{addEvent(JSON.parse(e.data))}catch(_){}});
    evSrc.addEventListener('oclog',function(e){try{addLogEntry(JSON.parse(e.data))}catch(_){}});
    evSrc.onopen=function(){$('sDot').className='dot live';$('sConn').textContent='live'};
    evSrc.onerror=function(){$('sDot').className='dot dead';$('sConn').textContent='reconnecting...'};
  }

  // ─── State polling ──────────────────────
  var prevAl={};
  function pollState(){
    fetch('/openalerts/state').then(function(r){return r.json()}).then(function(s){
      if(s.stats){
        $('sMsgs').textContent=s.stats.messagesProcessed||0;
        $('sErr').textContent=(s.stats.messageErrors||0)+(s.stats.webhookErrors||0)+(s.stats.toolErrors||0);
        $('sTools').textContent=s.stats.toolCalls||0;
        $('sAgents').textContent=s.stats.agentStarts||0;
      }
      if(s.uptimeMs!=null)$('sUp').textContent=fU(s.uptimeMs);
      if(s.recentAlerts){
        var nids={};
        for(var i=0;i<s.recentAlerts.length;i++){var a=s.recentAlerts[i];nids[a.id]=true;if(!prevAl[a.id])addAlert(a)}
        prevAl=nids;
      }
      if(s.rules){
        var sec=$('rulesEl'),rh='<h3>Rules</h3>';
        for(var j=0;j<s.rules.length;j++){var r=s.rules[j];var rf=r.status==='fired';rh+='<div class="rl"><span class="rl-d '+(rf?'fired':'ok')+'"></span><span>'+esc(r.id)+'</span><span class="rl-s">'+(rf?'FIRING':'OK')+'</span></div>'}
        sec.innerHTML=rh;
      }
      window._ss=s;
    }).catch(function(){});
  }

  // ─── Logs tab ──────────────────────
  var logSubsPopulated=false;

  /** Build an expandable log row for the Logs tab */
  function buildLogTabRow(e){
    var container=document.createElement('div');
    var row=document.createElement('div');row.className='log-e';
    row.innerHTML='<span class="log-ts">'+fT(e.tsMs||e.ts)+'</span><span class="log-lv '+esc(e.level)+'">'+esc(e.level)+'</span><span class="log-su">'+esc(e.subsystem)+'</span><span class="log-mg">'+esc(e.message)+'</span>';
    container.appendChild(row);

    // Build expandable detail
    var detail=document.createElement('div');detail.className='log-detail';
    var dh='<div class="ld-grid">';
    dh+='<span class="lk">Time</span><span class="lv">'+fISO(e.tsMs||e.ts)+'</span>';
    dh+='<span class="lk">Level</span><span class="lv">'+esc(e.level)+'</span>';
    dh+='<span class="lk">Subsystem</span><span class="lv">'+esc(e.subsystem)+'</span>';
    // ALL key-value pairs from extra
    var kvs=e.extra||{};
    var kvKeys=Object.keys(kvs);
    for(var i=0;i<kvKeys.length;i++){
      dh+='<span class="lk">'+esc(kvKeys[i])+'</span><span class="lv">'+esc(kvs[kvKeys[i]])+'</span>';
    }
    dh+='</div>';
    // File path + method
    if(e.filePath||e.method){
      dh+='<div class="ld-file">';
      if(e.filePath)dh+='\\u{1F4C4} '+esc(e.filePath);
      if(e.method)dh+=' ('+esc(e.method)+')';
      if(e.hostname)dh+=' @ '+esc(e.hostname);
      dh+='</div>';
    }
    detail.innerHTML=dh;
    container.appendChild(detail);

    row.addEventListener('click',function(){detail.classList.toggle('open')});
    return container;
  }

  /** Append a single SSE-streamed log entry to the Logs tab */
  function appendLogToTab(entry){
    var list=$('logList');
    var fSub=$('lF').value, fLev=$('lL').value, fSrch=$('lS').value.toLowerCase();
    var lp={'DEBUG':0,'INFO':1,'WARN':2,'ERROR':3};
    if(fSub&&entry.subsystem.indexOf(fSub)<0)return;
    if(fLev&&(lp[entry.level]||0)<(lp[fLev]||0))return;
    if(fSrch&&entry.message.toLowerCase().indexOf(fSrch)<0&&entry.subsystem.toLowerCase().indexOf(fSrch)<0)return;
    // Remove empty msg if present
    var em=list.querySelector('.empty-msg');if(em)em.remove();
    var row=buildLogTabRow(entry);
    list.appendChild(row);
    list.scrollTop=list.scrollHeight;
  }

  function refreshLogs(){
    fetch('/openalerts/logs?limit=300').then(function(r){return r.json()}).then(function(data){
      var list=$('logList');
      var entries=data.entries||[];
      var fSub=$('lF').value, fLev=$('lL').value, fSrch=$('lS').value.toLowerCase();
      var lp={'DEBUG':0,'INFO':1,'WARN':2,'ERROR':3};
      var minLev=lp[fLev]||0;

      // Populate subsystem dropdown dynamically (once, or when new subsystems appear)
      if(data.subsystems&&data.subsystems.length){
        var sel=$('lF');
        var cur=sel.value;
        var existing={};
        for(var oi=0;oi<sel.options.length;oi++)existing[sel.options[oi].value]=true;
        var changed=false;
        for(var si=0;si<data.subsystems.length;si++){
          if(!existing[data.subsystems[si]]){
            var opt=document.createElement('option');opt.value=data.subsystems[si];opt.textContent=data.subsystems[si];
            sel.appendChild(opt);changed=true;
          }
        }
        if(changed)sel.value=cur;
        logSubsPopulated=true;
      }

      list.innerHTML='';
      if(!entries.length){list.innerHTML='<div class="empty-msg">No logs found.</div>';return}

      for(var i=0;i<entries.length;i++){
        var e=entries[i];
        if(fSub&&e.subsystem.indexOf(fSub)<0)continue;
        if(fLev&&(lp[e.level]||0)<minLev)continue;
        if(fSrch&&e.message.toLowerCase().indexOf(fSrch)<0&&e.subsystem.toLowerCase().indexOf(fSrch)<0)continue;
        list.appendChild(buildLogTabRow(e));
      }
      list.scrollTop=list.scrollHeight;
    }).catch(function(){$('logList').innerHTML='<div class="empty-msg">Failed to load.</div>'});
  }
  $('lR').addEventListener('click',refreshLogs);
  $('lF').addEventListener('change',refreshLogs);
  $('lL').addEventListener('change',refreshLogs);
  var sDb;$('lS').addEventListener('input',function(){clearTimeout(sDb);sDb=setTimeout(refreshLogs,300)});
  // Fallback polling every 3s (SSE handles real-time now)
  setInterval(function(){if($('tab-logs').classList.contains('active')&&$('lA').checked&&!evSrc)refreshLogs()},3000);

  // ─── Health tab ──────────────────────
  function refreshHealth(){
    var s=window._ss;if(!s){pollState();setTimeout(refreshHealth,1000);return}
    var hEl=$('hC'),st=s.stats||{},up=s.uptimeMs||0;
    var html='';
    html+='<div class="h-sec"><h3>System</h3><div class="h-grid">';
    html+=hCard('Uptime',fU(up),'ok');
    html+=hCard('Started At',s.startedAt?new Date(s.startedAt).toLocaleString():'--','');
    html+=hCard('SSE Listeners',s.busListeners||0,'ok');
    var te=(st.messageErrors||0)+(st.webhookErrors||0)+(st.toolErrors||0)+(st.agentErrors||0);
    html+=hCard('Total Errors',te,te>0?'bad':'ok');
    html+=hCard('Platform',s.platformConnected?'Connected':'Off',s.platformConnected?'ok':'');
    // New cards
    var stuckN=s.stuckSessions!=null?s.stuckSessions:(st.stuckSessions||0);
    html+=hCard('Stuck Sessions',stuckN,stuckN>0?'bad':'ok');
    var hbAgo=s.lastHeartbeatTs?fAgo(s.lastHeartbeatTs):'never';
    var hbOk=s.lastHeartbeatTs&&(Date.now()-s.lastHeartbeatTs)<90000;
    html+=hCard('Last Heartbeat',hbAgo,hbOk?'ok':'bad');
    if(s.hourlyAlerts){
      html+=hCard('Hourly Alert Cap',s.hourlyAlerts.count+'/5'+(s.hourlyAlerts.resetAt?' (reset '+fAgo(s.hourlyAlerts.resetAt)+')':''),'');
    }
    if(s.lastResetTs){
      html+=hCard('Stats Reset',new Date(s.lastResetTs).toLocaleString(),'');
    }
    html+='</div></div>';

    html+='<div class="h-sec"><h3>Stats</h3><table class="h-tbl">';
    html+=hTr('Messages Processed',st.messagesProcessed||0)+hTr('Message Errors',st.messageErrors||0)+hTr('Webhook Errors',st.webhookErrors||0);
    html+=hTr('Tool Calls',st.toolCalls||0)+hTr('Tool Errors',st.toolErrors||0)+hTr('Agent Starts',st.agentStarts||0)+hTr('Agent Errors',st.agentErrors||0)+hTr('Sessions',st.sessionsStarted||0);
    html+=hTr('Stuck Sessions',stuckN);
    html+='</table></div>';

    html+='<div class="h-sec"><h3>Rules</h3><table class="h-tbl"><tr><th>Rule</th><th>Status</th><th>Last Fired</th></tr>';
    var cds=s.cooldowns||{};
    if(s.rules)for(var i=0;i<s.rules.length;i++){
      var r=s.rules[i];
      var cdTs=cds[r.id];
      var lastFired=cdTs?fAgo(cdTs):'--';
      html+='<tr><td>'+esc(r.id)+'</td><td>'+(r.status==='fired'?'<span style="color:#f85149;font-weight:700">FIRING</span>':'<span style="color:#3fb950">OK</span>')+'</td><td>'+lastFired+'</td></tr>';
    }
    html+='</table></div>';

    if(s.recentAlerts&&s.recentAlerts.length){
      html+='<div class="h-sec"><h3>Recent Alerts ('+s.recentAlerts.length+')</h3><table class="h-tbl">';
      for(var j=0;j<s.recentAlerts.length;j++){var a=s.recentAlerts[j];html+='<tr><td style="color:'+(a.severity==='critical'?'#ff7b72':a.severity==='warn'?'#d29922':'#f85149')+'">['+((a.severity||'?').toUpperCase())+'] '+esc(a.ruleId||'')+'</td><td>'+esc(a.title||'')+' \\u2014 '+esc(a.detail||'')+' ('+fT(a.ts)+')</td></tr>'}
      html+='</table></div>';
    }
    hEl.innerHTML=html;
  }
  function hCard(l,v,c){return'<div class="h-card"><div class="lb">'+esc(l)+'</div><div class="vl '+(c||'')+'">'+esc(String(v))+'</div></div>'}
  function hTr(l,v){return'<tr><td>'+esc(l)+'</td><td><b>'+esc(String(v))+'</b></td></tr>'}

  // ─── Boot ──────────────────────
  connectSSE();pollState();setInterval(pollState,4000);
})();
</script>
</body>
</html>`;
}
