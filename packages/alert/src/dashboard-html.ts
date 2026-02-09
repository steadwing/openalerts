/**
 * Single-page dashboard HTML for Steadwing real-time monitoring.
 * Flow-based event grouping: events nested under sessions/agents.
 */
export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Steadwing Monitor</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'SF Mono','Cascadia Code','Consolas',monospace;background:#0d1117;color:#c9d1d9;font-size:13px;overflow:hidden;height:100vh}

  .grid{display:grid;grid-template-rows:auto 1fr auto;height:100vh}

  /* ── Top bar ─────────────────────────────────────────────── */
  .topbar{background:#161b22;border-bottom:1px solid #30363d;padding:10px 16px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
  .topbar h1{font-size:15px;font-weight:600;color:#f0f6fc;letter-spacing:0.5px}
  .dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:4px}
  .dot.live{background:#3fb950;animation:pulse 2s infinite}
  .dot.dead{background:#f85149}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
  .stat{color:#8b949e;font-size:12px}
  .stat b{color:#c9d1d9;font-weight:500}

  /* ── Main panels ─────────────────────────────────────────── */
  .panels{display:grid;grid-template-columns:1fr 320px;gap:0;overflow:hidden}
  @media(max-width:800px){.panels{grid-template-columns:1fr}}

  .panel{border-right:1px solid #30363d;display:flex;flex-direction:column;overflow:hidden}
  .panel:last-child{border-right:none}
  .panel-header{background:#161b22;padding:8px 14px;font-size:12px;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:0.8px;border-bottom:1px solid #30363d;flex-shrink:0}

  /* ── Event stream (flow-based) ─────────────────────────── */
  .events{flex:1;overflow-y:auto;padding:4px 0}
  .events::-webkit-scrollbar{width:6px}
  .events::-webkit-scrollbar-thumb{background:#30363d;border-radius:3px}
  .empty-msg{color:#484f58;padding:40px 14px;text-align:center;font-style:italic}

  /* ── Flow container (session/agent grouping) ──────────── */
  .flow{margin:2px 0;border-left:3px solid #30363d;background:#0d1117}
  .flow.active{border-left-color:#58a6ff}
  .flow.done{border-left-color:#3fb950}
  .flow.error{border-left-color:#f85149}

  .flow-header{padding:6px 12px;display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;background:#161b22;border-bottom:1px solid #21262d}
  .flow-header:hover{background:#1c2129}
  .flow-toggle{color:#484f58;font-size:10px;width:12px;transition:transform 0.15s}
  .flow-toggle.collapsed{transform:rotate(-90deg)}
  .flow-label{font-weight:600;color:#c9d1d9}
  .flow-status{font-size:11px;padding:1px 6px;border-radius:3px;font-weight:600}
  .flow-status.active{background:#1f3a5f;color:#58a6ff}
  .flow-status.done{background:#1a3a2a;color:#3fb950}
  .flow-status.error{background:#3d1a1a;color:#f85149}
  .flow-meta{color:#484f58;font-size:11px;margin-left:auto}
  .flow-events{overflow:hidden;transition:max-height 0.2s ease}
  .flow-events.collapsed{max-height:0!important;overflow:hidden}

  /* ── Individual event row ──────────────────────────────── */
  .ev{padding:4px 14px 4px 28px;border-bottom:1px solid #161b22;font-size:12px;animation:fadeIn 0.25s ease}
  .ev:hover{background:#161b22}
  .ev.standalone{padding-left:14px;border-bottom:1px solid #21262d}
  .ev-top{display:flex;align-items:center;gap:8px}
  .ev-time{color:#484f58;font-size:11px;min-width:62px}
  .ev-type{font-weight:600;min-width:120px}
  .ev-badge{font-size:10px;padding:1px 5px;border-radius:3px;font-weight:600}
  .ev-badge.success{background:#1a3a2a;color:#3fb950}
  .ev-badge.error{background:#3d1a1a;color:#f85149}
  .ev-badge.timeout{background:#3d2e1a;color:#d29922}
  .ev-badge.active{background:#1f3a5f;color:#58a6ff}
  .ev-pills{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}
  .ev-pill{color:#8b949e;font-size:11px;background:#21262d;padding:1px 6px;border-radius:3px}
  .ev-pill.tool-name{color:#bc8cff;background:#2a1f3d}
  .ev-pill.duration{color:#d29922}
  .ev-pill.tokens{color:#58a6ff}
  .ev-pill.cost{color:#3fb950}
  .ev-pill.queue{color:#f0883e}
  .ev-detail{padding:3px 0 2px 70px;color:#6e7681;font-size:11px;line-height:1.4}
  .ev-detail .err-text{color:#f85149}
  .ev-detail .meta-text{color:#484f58}

  /* Event type colors */
  .ev-type.llm{color:#58a6ff}
  .ev-type.tool{color:#bc8cff}
  .ev-type.agent{color:#3fb950}
  .ev-type.session{color:#d29922}
  .ev-type.infra{color:#f85149}
  .ev-type.custom{color:#8b949e}
  .ev-type.watchdog{color:#6e7681}

  @keyframes fadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}

  /* ── Alerts panel ──────────────────────────────────────── */
  .alerts{flex:1;overflow-y:auto;padding:4px 0}
  .alert-item{padding:8px 14px;border-bottom:1px solid #21262d;font-size:12px;animation:fadeIn 0.3s ease}
  .alert-item .alert-sev{font-weight:700;text-transform:uppercase;font-size:11px}
  .alert-item .alert-sev.error{color:#f85149}
  .alert-item .alert-sev.warn{color:#d29922}
  .alert-item .alert-sev.critical{color:#ff7b72}
  .alert-item .alert-sev.info{color:#58a6ff}
  .alert-item .alert-title{color:#c9d1d9;margin-top:2px}
  .alert-item .alert-detail{color:#8b949e;margin-top:2px;font-size:11px}
  .alert-item .alert-time{color:#484f58;font-size:11px;margin-top:2px}

  /* ── Rules list ────────────────────────────────────────── */
  .rules-section{border-top:1px solid #30363d;padding:8px 14px;flex-shrink:0}
  .rules-section h3{font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:6px}
  .rule{display:flex;align-items:center;gap:6px;font-size:12px;padding:2px 0}
  .rule-dot{width:6px;height:6px;border-radius:50%}
  .rule-dot.ok{background:#3fb950}
  .rule-dot.fired{background:#f85149;animation:pulse 1s infinite}
  .rule-name{color:#c9d1d9}
  .rule-status{color:#8b949e;margin-left:auto;font-size:11px}

  /* ── Bottom bar ────────────────────────────────────────── */
  .bottombar{background:#161b22;border-top:1px solid #30363d;padding:10px 16px}
  .bottombar h3{font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px}
  .sim-row{display:flex;flex-wrap:wrap;gap:6px}
  .sim-btn{border:1px solid #30363d;border-radius:6px;padding:5px 10px;font-size:11px;font-family:inherit;cursor:pointer;transition:all 0.15s}
  .sim-btn.ok{background:#0d1117;color:#3fb950;border-color:#238636}
  .sim-btn.ok:hover{background:#238636;color:#fff}
  .sim-btn.err{background:#0d1117;color:#f85149;border-color:#da3633}
  .sim-btn.err:hover{background:#da3633;color:#fff}
  .sim-btn:active{transform:scale(0.95)}
  .sim-btn.flash{animation:btnflash 0.3s}
  @keyframes btnflash{0%{transform:scale(0.9)}50%{transform:scale(1.05)}100%{transform:scale(1)}}
</style>
</head>
<body>
<div class="grid">
  <!-- Top bar -->
  <div class="topbar">
    <h1><span class="dot dead" id="statusDot"></span> STEADWING</h1>
    <span class="stat" id="connLabel">connecting...</span>
    <span class="stat">uptime: <b id="uptime">--</b></span>
    <span class="stat">msgs: <b id="statMsgs">0</b></span>
    <span class="stat">errors: <b id="statErrors">0</b></span>
    <span class="stat">tools: <b id="statTools">0</b></span>
    <span class="stat">agents: <b id="statAgents">0</b></span>
    <span class="stat">sessions: <b id="statSessions">0</b></span>
  </div>

  <!-- Main panels -->
  <div class="panels">
    <!-- Event stream -->
    <div class="panel">
      <div class="panel-header">Activity Flow <span id="eventCount" style="float:right;color:#484f58">0 events</span></div>
      <div class="events" id="eventList">
        <div class="empty-msg" id="emptyMsg">Waiting for events... click Simulate below or send a message to the bot.</div>
      </div>
    </div>

    <!-- Alerts + Rules -->
    <div class="panel">
      <div class="panel-header">Alerts</div>
      <div class="alerts" id="alertList">
        <div class="empty-msg" id="alertEmpty">No alerts yet.</div>
      </div>
      <div class="rules-section" id="rulesSection">
        <h3>Rules</h3>
      </div>
    </div>
  </div>

  <!-- Bottom bar: Simulate -->
  <div class="bottombar">
    <h3>Simulate</h3>
    <div class="sim-row">
      <button class="sim-btn ok" data-key="heartbeat_ok">Heartbeat OK</button>
      <button class="sim-btn ok" data-key="llm_success">LLM OK</button>
      <button class="sim-btn ok" data-key="tool_success">Tool OK</button>
      <button class="sim-btn ok" data-key="agent_start">Agent Start</button>
      <button class="sim-btn ok" data-key="agent_end">Agent End</button>
      <button class="sim-btn err" data-key="webhook_error">Webhook Err</button>
      <button class="sim-btn err" data-key="llm_failure">LLM Fail</button>
      <button class="sim-btn err" data-key="session_stuck">Session Stuck</button>
      <button class="sim-btn err" data-key="heartbeat_fail">HB Fail</button>
      <button class="sim-btn err" data-key="tool_error">Tool Err</button>
      <button class="sim-btn err" data-key="queue_spike">Queue Spike</button>
    </div>
  </div>
</div>

<script>
(function() {
  const MAX_EVENTS = 500;
  const MAX_ALERTS = 100;
  const FLOW_TIMEOUT_MS = 120000; // close stale flows after 2 min
  let totalCount = 0;
  let paused = false;
  let evSource = null;

  const $ = id => document.getElementById(id);
  const eventList = $('eventList');
  const emptyMsg = $('emptyMsg');
  const alertList = $('alertList');
  const alertEmpty = $('alertEmpty');
  const eventCount = $('eventCount');

  // ── Helpers ─────────────────────────────────────────────
  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function category(type) {
    if (!type) return 'custom';
    const p = type.split('.')[0];
    return ['llm','tool','agent','session','infra','watchdog'].includes(p) ? p : 'custom';
  }
  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString('en-US', {hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
  }
  function fmtDur(ms) {
    if (ms == null) return '';
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms/1000).toFixed(1) + 's';
    return Math.floor(ms/60000) + 'm ' + Math.round((ms%60000)/1000) + 's';
  }
  function fmtUptime(ms) {
    const s = Math.floor(ms/1000), m = Math.floor(s/60), h = Math.floor(m/60);
    return h > 0 ? h+'h '+m%60+'m' : m+'m '+s%60+'s';
  }

  // ── Flow Tracker ────────────────────────────────────────
  // Groups events by sessionKey. Events with matching sessionKey
  // appear nested under a collapsible flow container.
  // Flow types: agent.start → opens, agent.end/error → closes.
  // Session.start/end also create flows.
  const flows = new Map(); // sessionKey → { el, eventsEl, status, count, startTs }

  function isFlowStarter(type) {
    return type === 'agent.start' || type === 'session.start';
  }
  function isFlowEnder(type) {
    return type === 'agent.end' || type === 'agent.error' || type === 'session.end';
  }

  function getOrCreateFlow(ev) {
    const key = ev.sessionKey || ev.agentId;
    if (!key) return null;

    let flow = flows.get(key);

    if (!flow) {
      // Create new flow container
      const container = document.createElement('div');
      container.className = 'flow active';
      container.dataset.key = key;

      const header = document.createElement('div');
      header.className = 'flow-header';
      const shortKey = key.length > 12 ? key.slice(0,12) + '..' : key;
      const label = ev.agentId ? 'Agent ' + (ev.agentId.length > 10 ? ev.agentId.slice(0,10)+'..' : ev.agentId) : 'Session';
      header.innerHTML =
        '<span class="flow-toggle">\\u25BC</span>' +
        '<span class="flow-label">' + esc(label) + '</span>' +
        '<span class="flow-status active" data-role="status">active</span>' +
        '<span class="flow-meta" data-role="meta">' + esc(shortKey) + ' \\u00B7 ' + fmtTime(ev.ts) + '</span>';

      header.addEventListener('click', function() {
        const toggle = header.querySelector('.flow-toggle');
        const events = container.querySelector('.flow-events');
        const collapsed = !events.classList.contains('collapsed');
        events.classList.toggle('collapsed', collapsed);
        toggle.classList.toggle('collapsed', collapsed);
      });

      const eventsEl = document.createElement('div');
      eventsEl.className = 'flow-events';

      container.appendChild(header);
      container.appendChild(eventsEl);

      flow = { el: container, eventsEl, headerEl: header, status: 'active', count: 0, startTs: ev.ts, key };
      flows.set(key, flow);

      // Insert at top of event list
      emptyMsg.style.display = 'none';
      eventList.insertBefore(container, eventList.firstChild);
    }

    return flow;
  }

  function updateFlowStatus(flow, status, ev) {
    flow.status = status;
    flow.el.className = 'flow ' + status;
    const statusEl = flow.headerEl.querySelector('[data-role="status"]');
    if (statusEl) {
      statusEl.className = 'flow-status ' + status;
      statusEl.textContent = status;
    }
    // Update meta with duration
    if (ev && (ev.durationMs != null || status !== 'active')) {
      const metaEl = flow.headerEl.querySelector('[data-role="meta"]');
      if (metaEl) {
        const dur = ev.durationMs != null ? ' \\u00B7 ' + fmtDur(ev.durationMs) : '';
        const tok = ev.tokenCount != null ? ' \\u00B7 ' + ev.tokenCount + 'tok' : '';
        const cnt = flow.count + ' events';
        metaEl.textContent = flow.key.slice(0,12) + ' \\u00B7 ' + cnt + dur + tok;
      }
    }
  }

  // ── Build event row DOM ─────────────────────────────────
  function buildEventRow(ev, nested) {
    const div = document.createElement('div');
    div.className = 'ev' + (nested ? '' : ' standalone');

    const cat = category(ev.type);
    const oc = ev.outcome || '';

    // Top line: time, type, outcome badge, info pills
    let topHtml = '<div class="ev-top">';
    topHtml += '<span class="ev-time">' + fmtTime(ev.ts) + '</span>';
    topHtml += '<span class="ev-type ' + cat + '">' + esc(ev.type || 'unknown') + '</span>';

    if (oc) {
      topHtml += '<span class="ev-badge ' + oc + '">' + (oc === 'success' ? '\\u2713' : oc === 'error' ? '\\u2717' : oc === 'timeout' ? '\\u23F1' : '') + ' ' + oc + '</span>';
    }

    // Info pills (right-aligned)
    topHtml += '<span class="ev-pills">';
    if (ev.meta && ev.meta.toolName) topHtml += '<span class="ev-pill tool-name">' + esc(String(ev.meta.toolName)) + '</span>';
    if (ev.durationMs != null) topHtml += '<span class="ev-pill duration">' + fmtDur(ev.durationMs) + '</span>';
    if (ev.tokenCount != null) topHtml += '<span class="ev-pill tokens">' + ev.tokenCount + ' tok</span>';
    if (ev.costUsd != null) topHtml += '<span class="ev-pill cost">$' + Number(ev.costUsd).toFixed(4) + '</span>';
    if (ev.queueDepth != null) topHtml += '<span class="ev-pill queue">depth=' + ev.queueDepth + '</span>';
    if (ev.channel) topHtml += '<span class="ev-pill">' + esc(ev.channel) + '</span>';
    topHtml += '</span></div>';

    // Detail line: error message, meta info
    let detailHtml = '';
    const detailParts = [];
    if (ev.error) detailParts.push('<span class="err-text">' + esc(ev.error) + '</span>');
    if (ev.ageMs != null) detailParts.push('stuck for ' + fmtDur(ev.ageMs));
    if (ev.meta) {
      if (ev.meta.model) detailParts.push('<span class="meta-text">model: ' + esc(String(ev.meta.model)) + '</span>');
      if (ev.meta.provider) detailParts.push('<span class="meta-text">provider: ' + esc(String(ev.meta.provider)) + '</span>');
      if (ev.meta.source && String(ev.meta.source).startsWith('hook:')) detailParts.push('<span class="meta-text">via ' + esc(String(ev.meta.source)) + '</span>');
      if (ev.meta.messageCount != null) detailParts.push('<span class="meta-text">' + ev.meta.messageCount + ' messages</span>');
      if (ev.meta.lane) detailParts.push('<span class="meta-text">lane: ' + esc(String(ev.meta.lane)) + '</span>');
      if (ev.meta.sessionState) detailParts.push('<span class="meta-text">state: ' + esc(String(ev.meta.sessionState)) + '</span>');
    }
    if (ev.sessionKey && !nested) detailParts.push('<span class="meta-text">session: ' + esc(ev.sessionKey.slice(0,12)) + '</span>');
    if (ev.agentId && !nested) detailParts.push('<span class="meta-text">agent: ' + esc(ev.agentId.slice(0,12)) + '</span>');

    if (detailParts.length > 0) {
      detailHtml = '<div class="ev-detail">' + detailParts.join(' \\u00B7 ') + '</div>';
    }

    div.innerHTML = topHtml + detailHtml;
    return div;
  }

  // ── Ingest event into the view ──────────────────────────
  function addEvent(ev) {
    totalCount++;
    eventCount.textContent = totalCount + ' events';
    emptyMsg.style.display = 'none';

    if (paused) return;

    const key = ev.sessionKey || ev.agentId;

    // Try to add to an existing or new flow
    if (key) {
      // Create flow on flow-starting events or if one exists
      if (isFlowStarter(ev.type) || flows.has(key)) {
        const flow = getOrCreateFlow(ev);
        if (flow) {
          flow.count++;
          const row = buildEventRow(ev, true);
          flow.eventsEl.appendChild(row);

          // Update flow status
          if (isFlowEnder(ev.type)) {
            const endStatus = ev.outcome === 'error' || ev.type === 'agent.error' ? 'error' : 'done';
            updateFlowStatus(flow, endStatus, ev);
          }

          // Scroll parent into view
          flow.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          return;
        }
      }
    }

    // Standalone event (no session context or not part of a flow)
    const row = buildEventRow(ev, false);
    if (eventList.firstChild && eventList.firstChild !== emptyMsg) {
      eventList.insertBefore(row, eventList.firstChild);
    } else {
      eventList.appendChild(row);
    }

    // Trim old standalone events
    while (eventList.querySelectorAll('.ev.standalone').length > 200) {
      const all = eventList.querySelectorAll('.ev.standalone');
      all[all.length - 1].remove();
    }
  }

  // ── Stale flow cleanup ──────────────────────────────────
  setInterval(function() {
    const now = Date.now();
    for (const [key, flow] of flows) {
      if (flow.status === 'active' && now - flow.startTs > FLOW_TIMEOUT_MS) {
        updateFlowStatus(flow, 'done', null);
      }
      // Remove very old completed flows from DOM
      if (flow.status !== 'active' && now - flow.startTs > 600000) {
        flow.el.remove();
        flows.delete(key);
      }
    }
  }, 30000);

  // ── Render one alert ────────────────────────────────────
  function addAlert(a) {
    alertEmpty.style.display = 'none';
    const div = document.createElement('div');
    div.className = 'alert-item';
    div.innerHTML =
      '<div class="alert-sev ' + (a.severity||'error') + '">[' + (a.severity||'ERROR').toUpperCase() + '] ' + esc(a.ruleId||'') + '</div>' +
      '<div class="alert-title">' + esc(a.title||'Alert') + '</div>' +
      '<div class="alert-detail">' + esc(a.detail||'') + '</div>' +
      '<div class="alert-time">' + fmtTime(a.ts) + '</div>';
    alertList.insertBefore(div, alertList.firstChild);
    while (alertList.children.length > MAX_ALERTS + 1) {
      alertList.removeChild(alertList.lastChild);
    }
  }

  // ── Pause on hover ──────────────────────────────────────
  eventList.addEventListener('mouseenter', function() { paused = true; });
  eventList.addEventListener('mouseleave', function() { paused = false; });

  // ── SSE connection ──────────────────────────────────────
  function connectSSE() {
    if (evSource) evSource.close();
    evSource = new EventSource('/steadwing/events');
    evSource.addEventListener('steadwing', function(e) {
      try {
        const data = JSON.parse(e.data);
        addEvent(data);
      } catch(_) {}
    });
    evSource.onopen = function() {
      $('statusDot').className = 'dot live';
      $('connLabel').textContent = 'live';
    };
    evSource.onerror = function() {
      $('statusDot').className = 'dot dead';
      $('connLabel').textContent = 'reconnecting...';
    };
  }

  // ── State polling (stats + alerts + rules) ──────────────
  let prevAlertIds = new Set();

  function pollState() {
    fetch('/steadwing/state').then(function(r){ return r.json(); }).then(function(state) {
      if (state.stats) {
        $('statMsgs').textContent = state.stats.messagesProcessed || 0;
        $('statErrors').textContent = (state.stats.messageErrors || 0) + (state.stats.webhookErrors || 0);
        $('statTools').textContent = state.stats.toolCalls || 0;
        $('statAgents').textContent = state.stats.agentStarts || 0;
        $('statSessions').textContent = state.stats.sessionsStarted || 0;
      }
      if (state.uptimeMs != null) {
        $('uptime').textContent = fmtUptime(state.uptimeMs);
      }
      // Detect new alerts (compare IDs with previous poll)
      if (state.recentAlerts && state.recentAlerts.length > 0) {
        var newIds = new Set();
        for (var i = 0; i < state.recentAlerts.length; i++) {
          var a = state.recentAlerts[i];
          newIds.add(a.id);
          if (!prevAlertIds.has(a.id)) {
            addAlert(a);
          }
        }
        prevAlertIds = newIds;
      }
      // Rules
      if (state.rules) {
        var sec = $('rulesSection');
        var html = '<h3>Rules</h3>';
        for (var j = 0; j < state.rules.length; j++) {
          var r = state.rules[j];
          var fired = r.status === 'fired';
          html += '<div class="rule"><span class="rule-dot ' + (fired ? 'fired' : 'ok') + '"></span><span class="rule-name">' + esc(r.id) + '</span><span class="rule-status">' + (fired ? 'FIRING' : 'OK') + '</span></div>';
        }
        sec.innerHTML = html;
      }
    }).catch(function(){});
  }

  // ── Simulate buttons ────────────────────────────────────
  document.querySelectorAll('.sim-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var key = this.dataset.key;
      this.classList.add('flash');
      var self = this;
      setTimeout(function(){ self.classList.remove('flash'); }, 300);
      fetch('/steadwing/simulate', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({scenario: key})
      }).catch(function(){});
    });
  });

  // ── Boot ────────────────────────────────────────────────
  connectSSE();
  pollState();
  setInterval(pollState, 4000);
})();
</script>
</body>
</html>`;
}
