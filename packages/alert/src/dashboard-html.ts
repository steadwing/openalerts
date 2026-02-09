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
          <select id="lF"><option value="">All</option><option value="diagnostic">diagnostic</option><option value="plugins">plugins</option><option value="agent">agent</option><option value="gateway">gateway</option></select>
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
  function fD(ms){if(ms==null)return'';if(ms<1000)return ms+'ms';if(ms<60000)return(ms/1000).toFixed(1)+'s';return Math.floor(ms/60000)+'m '+Math.round((ms%60000)/1000)+'s'}
  function fU(ms){var s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60);return h>0?h+'h '+m%60+'m':m+'m '+s%60+'s'}

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
    hdr.innerHTML='<span class="flow-arr">\\u25BC</span><span class="flow-lbl">Session '+esc(short)+'</span><span class="flow-badge active" data-r="st">active</span><span class="flow-info" data-r="info">'+fT(ev.ts||ev.tsMs)+'</span>';
    var body=document.createElement('div');body.className='flow-body';
    hdr.addEventListener('click',function(){
      var shut=!body.classList.contains('shut');
      body.classList.toggle('shut',shut);
      hdr.querySelector('.flow-arr').classList.toggle('shut',shut);
    });
    c.appendChild(hdr);c.appendChild(body);
    var f={el:c,body:body,hdr:hdr,st:'active',n:0,startTs:Date.now(),sid:sid,err:false,dur:0,tok:0,tools:0,llms:0};
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
      if(f.tools>0)ps.push(f.tools+' tools');
      if(f.llms>0)ps.push(f.llms+' llm');
      iEl.textContent=ps.join(' \\u00B7 ');
    }
  }

  // ─── Build an OpenAlerts event row ──────────────────────
  function buildEvRow(ev,depth){
    var div=document.createElement('div');
    div.className='row'+(depth===0?' standalone':depth>1?' deep':'');
    var c=cat(ev.type),oc=ev.outcome||'',m=ev.meta||{};
    var ft=ev.type||'?';
    if(ft==='custom'&&m.openclawEventType==='session.state')ft='session.'+(m.sessionState||'state');
    if(ft==='custom'&&m.openclawEventType==='message_sent')ft='msg.delivered';

    var h='<div class="r-main">';
    h+='<span class="r-time">'+fT(ev.ts)+'</span>';
    h+='<span class="r-type '+c+'">'+esc(ft)+'</span>';
    if(oc)h+='<span class="r-oc '+oc+'">'+(oc==='success'?'\\u2713':oc==='error'?'\\u2717':'\\u25CB')+' '+oc+'</span>';
    h+='<span class="r-pills">';
    if(m.toolName)h+='<span class="p t">'+esc(String(m.toolName))+'</span>';
    if(ev.durationMs!=null)h+='<span class="p d">'+fD(ev.durationMs)+'</span>';
    if(ev.tokenCount!=null)h+='<span class="p tk">'+ev.tokenCount+' tok</span>';
    if(ev.queueDepth!=null)h+='<span class="p q">q='+ev.queueDepth+'</span>';
    if(m.model)h+='<span class="p m">'+esc(String(m.model))+'</span>';
    if(ev.channel)h+='<span class="p ch">'+esc(ev.channel)+'</span>';
    if(m.messageCount!=null)h+='<span class="p">'+m.messageCount+' msgs</span>';
    if(m.source&&String(m.source)!=='simulate')h+='<span class="p s">'+esc(String(m.source))+'</span>';
    h+='</span></div>';

    var ds=[];
    if(ev.error)ds.push('<span class="err">'+esc(ev.error)+'</span>');
    if(ev.ageMs!=null)ds.push('stuck '+fD(ev.ageMs));
    if(m.sessionState)ds.push('<span class="sc">'+(m.previousState||'?')+' \\u2192 '+m.sessionState+'</span>');
    if(m.provider)ds.push('<span class="dim">provider: '+esc(String(m.provider))+'</span>');
    if(m.to)ds.push('<span class="dim">to: '+esc(String(m.to))+'</span>');
    if(ev.sessionKey&&depth===0)ds.push('<span class="dim">session: '+esc(ev.sessionKey.slice(0,12))+'</span>');
    if(ds.length)h+='<div class="r-det">'+ds.join(' \\u00B7 ')+'</div>';

    div.innerHTML=h;return div;
  }

  // ─── Build an OpenClaw log row ──────────────────────
  function buildLogRow(entry,depth){
    var div=document.createElement('div');
    div.className='row log'+(depth===0?' standalone':depth>1?' deep':'');
    var h='<div class="r-main">';
    h+='<span class="r-time">'+fT(entry.tsMs||entry.ts)+'</span>';
    h+='<span class="r-lvl '+esc(entry.level)+'">'+esc(entry.level)+'</span>';
    h+='<span class="r-sub" title="'+esc(entry.subsystem)+'">'+subIcon(entry.subsystem)+' '+esc(entry.subsystem)+'</span>';
    h+='<span class="r-msg">'+esc(entry.message)+'</span>';
    h+='</div>';

    // Show parsed key=value pairs if any
    var kvs=entry.extra||{};
    var kvParts=[];
    if(kvs.sessionId)kvParts.push('<span>session='+esc(kvs.sessionId.slice(0,12))+'..</span>');
    if(kvs.runId)kvParts.push('<span>run='+esc(kvs.runId.slice(0,12))+'..</span>');
    if(kvs.durationMs)kvParts.push('<span>duration='+fD(parseInt(kvs.durationMs))+'</span>');
    if(kvs.totalActive)kvParts.push('<span>active='+esc(kvs.totalActive)+'</span>');
    if(kvs.queueDepth)kvParts.push('<span>queue='+esc(kvs.queueDepth)+'</span>');
    if(kvs.prev)kvParts.push('<span>'+esc(kvs.prev)+' \\u2192 '+esc(kvs.new||'?')+'</span>');
    if(kvParts.length)h+='<div class="r-kvs">'+kvParts.join('')+'</div>';

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
      if(ev.type==='tool.call'||ev.type==='tool.error')f.tools++;
      if(ev.type==='llm.call')f.llms++;
      if(ev.outcome==='error')f.err=true;
      var depth=1;
      if(ev.type==='tool.call'||ev.type==='tool.error'||ev.type==='llm.call'||ev.type==='llm.token_usage')depth=2;
      f.body.appendChild(buildEvRow(ev,depth));
      if(evList.firstChild!==f.el)evList.insertBefore(f.el,evList.firstChild);
      if(ev.type==='agent.end'||ev.type==='session.end'){if(ev.durationMs)f.dur=ev.durationMs;updFlow(f,f.err?'error':'done')}
      else if(ev.type==='agent.error'){f.err=true;if(ev.durationMs)f.dur=ev.durationMs;updFlow(f,'error')}
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
    var sid=entry.sessionId;
    if(sid&&flows[sid]){
      var f=flows[sid];f.n++;
      f.body.appendChild(buildLogRow(entry,1));
      if(evList.firstChild!==f.el)evList.insertBefore(f.el,evList.firstChild);
      updFlow(f,f.st);
      f.el.scrollIntoView({block:'nearest',behavior:'smooth'});
      return;
    }
    // If log has a sessionId but no flow exists yet, create one
    if(sid){
      var f=getFlow(sid,entry);f.n++;
      f.body.appendChild(buildLogRow(entry,1));
      updFlow(f,f.st);
      f.el.scrollIntoView({block:'nearest',behavior:'smooth'});
      return;
    }
    // Standalone log entry
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
        var sec=$('rulesEl'),h='<h3>Rules</h3>';
        for(var j=0;j<s.rules.length;j++){var r=s.rules[j];var f=r.status==='fired';h+='<div class="rl"><span class="rl-d '+(f?'fired':'ok')+'"></span><span>'+esc(r.id)+'</span><span class="rl-s">'+(f?'FIRING':'OK')+'</span></div>'}
        sec.innerHTML=h;
      }
      window._ss=s;
    }).catch(function(){});
  }

  // ─── Logs tab ──────────────────────
  var lastLogLineCount=0;
  function refreshLogs(){
    fetch('/openalerts/logs?limit=300').then(function(r){return r.json()}).then(function(data){
      var list=$('logList');
      var entries=data.entries||[];
      var fSub=$('lF').value, fLev=$('lL').value, fSrch=$('lS').value.toLowerCase();
      var lp={'DEBUG':0,'INFO':1,'WARN':2,'ERROR':3};
      var minLev=lp[fLev]||0;

      // Only re-render if new entries
      if(entries.length===lastLogLineCount&&!fSub&&!fLev&&!fSrch)return;
      lastLogLineCount=entries.length;
      list.innerHTML='';
      if(!entries.length){list.innerHTML='<div class="empty-msg">No logs found.</div>';return}

      for(var i=0;i<entries.length;i++){
        var e=entries[i];
        if(fSub&&e.subsystem.indexOf(fSub)<0)continue;
        if(fLev&&(lp[e.level]||0)<minLev)continue;
        if(fSrch&&e.message.toLowerCase().indexOf(fSrch)<0&&e.subsystem.toLowerCase().indexOf(fSrch)<0)continue;
        var row=document.createElement('div');row.className='log-e';
        row.innerHTML='<span class="log-ts">'+fT(e.tsMs||e.ts)+'</span><span class="log-lv '+esc(e.level)+'">'+esc(e.level)+'</span><span class="log-su">'+esc(e.subsystem)+'</span><span class="log-mg">'+esc(e.message)+'</span>';
        list.appendChild(row);
      }
      list.scrollTop=list.scrollHeight;
    }).catch(function(){$('logList').innerHTML='<div class="empty-msg">Failed to load.</div>'});
  }
  $('lR').addEventListener('click',refreshLogs);
  $('lF').addEventListener('change',refreshLogs);
  $('lL').addEventListener('change',refreshLogs);
  var sDb;$('lS').addEventListener('input',function(){clearTimeout(sDb);sDb=setTimeout(refreshLogs,300)});
  setInterval(function(){if($('tab-logs').classList.contains('active')&&$('lA').checked)refreshLogs()},3000);

  // ─── Health tab ──────────────────────
  function refreshHealth(){
    var s=window._ss;if(!s){pollState();setTimeout(refreshHealth,1000);return}
    var h=$('hC'),st=s.stats||{},up=s.uptimeMs||0;
    var html='';
    html+='<div class="h-sec"><h3>System</h3><div class="h-grid">';
    html+=hCard('Uptime',fU(up),'ok')+hCard('SSE Listeners',s.busListeners||0,'ok');
    var te=(st.messageErrors||0)+(st.webhookErrors||0)+(st.toolErrors||0)+(st.agentErrors||0);
    html+=hCard('Total Errors',te,te>0?'bad':'ok')+hCard('Platform',s.platformConnected?'Connected':'Off',s.platformConnected?'ok':'');
    html+='</div></div>';
    html+='<div class="h-sec"><h3>Stats</h3><table class="h-tbl">';
    html+=hTr('Messages Processed',st.messagesProcessed||0)+hTr('Message Errors',st.messageErrors||0)+hTr('Webhook Errors',st.webhookErrors||0);
    html+=hTr('Tool Calls',st.toolCalls||0)+hTr('Tool Errors',st.toolErrors||0)+hTr('Agent Starts',st.agentStarts||0)+hTr('Agent Errors',st.agentErrors||0)+hTr('Sessions',st.sessionsStarted||0);
    html+='</table></div>';
    html+='<div class="h-sec"><h3>Rules</h3><table class="h-tbl">';
    if(s.rules)for(var i=0;i<s.rules.length;i++){var r=s.rules[i];html+='<tr><td>'+esc(r.id)+'</td><td>'+(r.status==='fired'?'<span style="color:#f85149;font-weight:700">FIRING</span>':'<span style="color:#3fb950">OK</span>')+'</td></tr>'}
    html+='</table></div>';
    if(s.recentAlerts&&s.recentAlerts.length){
      html+='<div class="h-sec"><h3>Recent Alerts ('+s.recentAlerts.length+')</h3><table class="h-tbl">';
      for(var j=0;j<s.recentAlerts.length;j++){var a=s.recentAlerts[j];html+='<tr><td style="color:'+(a.severity==='critical'?'#ff7b72':a.severity==='warn'?'#d29922':'#f85149')+'">['+((a.severity||'?').toUpperCase())+'] '+esc(a.ruleId||'')+'</td><td>'+esc(a.title||'')+' \\u2014 '+esc(a.detail||'')+' ('+fT(a.ts)+')</td></tr>'}
      html+='</table></div>';
    }
    h.innerHTML=html;
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
