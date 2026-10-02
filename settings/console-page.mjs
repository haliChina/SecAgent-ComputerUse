// 设置控制台单文件页面（内联 CSS + vanilla JS）。
// 注意：页面脚本刻意只用单引号字符串与字符串拼接，不使用反引号 / ${}，以便整体包在 String.raw 里。

export const CONSOLE_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Computer Use 设置</title>
<style>
  :root {
    --bg:#f4f5f7; --card:#ffffff; --ink:#1c2330; --muted:#6b7280; --line:#e5e7eb;
    --primary:#2563eb; --primary-ink:#ffffff; --ok:#16a34a; --warn:#d97706; --err:#dc2626;
    --chip:#eef2ff; --chip-ink:#4338ca; --guide:#f3f4f6; --guide-ink:#4b5563;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
    font:14px/1.5 -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif; }
  .wrap { max-width:780px; margin:0 auto; padding:28px 18px 80px; }
  header.top h1 { margin:0 0 4px; font-size:20px; }
  header.top p { margin:0 0 18px; color:var(--muted); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px;
    padding:18px 18px 8px; margin-bottom:16px; box-shadow:0 1px 2px rgba(16,24,40,.04); }
  .card > h2 { margin:0 0 2px; font-size:15px; display:flex; align-items:center; gap:8px; }
  .card > .gdesc { margin:0 0 12px; color:var(--muted); font-size:12.5px; }
  .field { padding:10px 0; border-top:1px solid #f0f1f3; }
  .field:first-of-type { border-top:none; }
  .field .flabel { display:flex; align-items:center; gap:8px; font-weight:600; font-size:13.5px; }
  .field .fhint { color:var(--muted); font-size:12px; margin:3px 0 8px; }
  .badge { font-size:11px; font-weight:600; padding:1px 7px; border-radius:999px; white-space:nowrap; }
  .badge.immediate { background:#dcfce7; color:#166534; }
  .badge.guidance { background:var(--guide); color:var(--guide-ink); }
  input[type=text], input[type=number], select {
    width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:9px;
    font:inherit; color:inherit; background:#fff; }
  input:focus, select:focus { outline:2px solid #bfdbfe; border-color:#93c5fd; }
  .switch { position:relative; width:42px; height:24px; flex:none; }
  .switch input { opacity:0; width:0; height:0; }
  .slider { position:absolute; inset:0; background:#cbd5e1; border-radius:999px; transition:.15s; cursor:pointer; }
  .slider:before { content:""; position:absolute; width:18px; height:18px; left:3px; top:3px;
    background:#fff; border-radius:50%; transition:.15s; }
  .switch input:checked + .slider { background:var(--primary); }
  .switch input:checked + .slider:before { transform:translateX(18px); }
  .boolrow { display:flex; align-items:center; justify-content:space-between; gap:12px; }
  .boolrow .flabel { flex:1; }
  .svc { border:1px dashed #c7d2fe; background:#f8faff; border-radius:11px; padding:14px; margin:6px 0 14px; }
  .svc-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:10px; }
  .pill { font-size:12px; font-weight:700; padding:2px 10px; border-radius:999px; }
  .pill.not-installed { background:#f3f4f6; color:#4b5563; }
  .pill.installing, .pill.starting { background:#fef3c7; color:#92400e; }
  .pill.installed, .pill.stopped { background:#e0e7ff; color:#3730a3; }
  .pill.running { background:#dcfce7; color:#166534; }
  .pill.error { background:#fee2e2; color:#991b1b; }
  .progress { height:8px; background:#e5e7eb; border-radius:999px; overflow:hidden; margin:8px 0; }
  .progress > div { height:100%; background:var(--primary); width:0; transition:width .3s; }
  .svc-msg { font-size:12px; color:var(--muted); margin:4px 0 10px; word-break:break-word; }
  .btnrow { display:flex; gap:8px; flex-wrap:wrap; }
  button { font:inherit; font-weight:600; border-radius:9px; padding:8px 14px; cursor:pointer; border:1px solid transparent; }
  button:disabled { opacity:.55; cursor:not-allowed; }
  .primary { background:var(--primary); color:var(--primary-ink); }
  .secondary { background:#fff; color:#374151; border-color:var(--line); }
  .danger { background:#fff; color:var(--err); border-color:#fecaca; }
  .footer { position:fixed; left:0; right:0; bottom:0; background:rgba(255,255,255,.92);
    border-top:1px solid var(--line); backdrop-filter:blur(6px); }
  .footer .inner { max-width:780px; margin:0 auto; padding:12px 18px; display:flex; gap:10px; align-items:center; }
  .save-status { font-size:12.5px; color:var(--muted); }
  .save-status.ok { color:var(--ok); } .save-status.err { color:var(--err); }
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <h1>Computer Use 设置</h1>
    <p>调整感知、本地视觉兜底、思考提醒与动作参数。</p>
  </header>
  <div id="groups"></div>
</div>
<div class="footer">
  <div class="inner">
    <button class="primary" id="save">保存设置</button>
    <button class="secondary" id="reset">恢复默认</button>
    <span class="save-status" id="saveStatus"></span>
  </div>
</div>

<script>
(function () {
  var KEY = new URLSearchParams(location.search).get('key') || '';
  var fieldRefs = {};   // key -> { field, input }
  var pollTimer = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function api(path, options) {
    return fetch(path + '?key=' + encodeURIComponent(KEY), options).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
        return data;
      });
    });
  }
  function post(path, body) {
    return api(path, { method:'POST', headers:{ 'Content-Type':'application/json' },
      body: body ? JSON.stringify(body) : undefined });
  }

  function effectBadge(field) {
    var b = el('span', 'badge ' + field.effect);
    b.textContent = field.effect === 'immediate' ? '立即生效' : '行为引导';
    b.title = field.effect === 'immediate'
      ? '后端会真正读取该参数'
      : '通过提示词引导模型，引擎层不强制';
    return b;
  }

  function makeInput(field, value) {
    if (field.type === 'boolean') {
      var sw = el('label', 'switch');
      var cb = el('input'); cb.type = 'checkbox'; cb.checked = !!value;
      var sl = el('span', 'slider');
      sw.appendChild(cb); sw.appendChild(sl);
      return { control: sw, input: cb };
    }
    if (field.type === 'select') {
      var sel = el('select');
      field.options.forEach(function (o) {
        var op = el('option'); op.value = o.value; op.textContent = o.label;
        if (o.value === value) op.selected = true;
        sel.appendChild(op);
      });
      return { control: sel, input: sel };
    }
    var inp = el('input');
    inp.type = field.type === 'number' ? 'number' : 'text';
    if (field.type === 'number') {
      inp.min = field.min; inp.max = field.max; inp.step = field.step;
    }
    inp.value = value == null ? '' : value;
    return { control: inp, input: inp };
  }

  function renderField(container, field, value) {
    var wrap = el('div', 'field');
    if (field.type === 'boolean') {
      var row = el('div', 'boolrow');
      var left = el('div');
      var lab = el('div', 'flabel');
      lab.appendChild(document.createTextNode(field.label));
      lab.appendChild(effectBadge(field));
      left.appendChild(lab);
      if (field.hint) left.appendChild(el('div', 'fhint', field.hint));
      var made = makeInput(field, value);
      row.appendChild(left); row.appendChild(made.control);
      wrap.appendChild(row);
      fieldRefs[field.key] = { field: field, input: made.input };
    } else {
      var lab2 = el('div', 'flabel');
      lab2.appendChild(document.createTextNode(field.label));
      lab2.appendChild(effectBadge(field));
      wrap.appendChild(lab2);
      if (field.hint) wrap.appendChild(el('div', 'fhint', field.hint));
      var made2 = makeInput(field, value);
      wrap.appendChild(made2.control);
      fieldRefs[field.key] = { field: field, input: made2.input };
    }
    container.appendChild(wrap);
  }

  function readValues() {
    var out = {};
    Object.keys(fieldRefs).forEach(function (key) {
      var ref = fieldRefs[key];
      if (ref.field.type === 'boolean') out[key] = ref.input.checked;
      else if (ref.field.type === 'number') out[key] = Number(ref.input.value);
      else out[key] = ref.input.value;
    });
    return out;
  }

  // —— OmniParser 服务面板 ——
  function svcPanel(section) {
    var box = el('div', 'svc');
    var head = el('div', 'svc-head');
    head.appendChild(el('strong', null, '本地视觉服务'));
    var pill = el('span', 'pill not-installed', '未安装');
    head.appendChild(pill);
    box.appendChild(head);
    var prog = el('div', 'progress'); var bar = el('div'); prog.appendChild(bar);
    box.appendChild(prog);
    var msg = el('div', 'svc-msg'); box.appendChild(msg);
    var btns = el('div', 'btnrow');
    var bInstall = el('button', 'primary', '一键安装并启动');
    var bStart = el('button', 'secondary', '启动');
    var bStop = el('button', 'secondary', '停止');
    var bUninstall = el('button', 'danger', '卸载');
    btns.appendChild(bInstall); btns.appendChild(bStart); btns.appendChild(bStop); btns.appendChild(bUninstall);
    box.appendChild(btns);
    section.appendChild(box);

    function apply(st) {
      pill.className = 'pill ' + st.phase;
      var labels = { 'not-installed':'未安装', installing:'安装中', installed:'已安装',
        starting:'启动中', running:'运行中', stopped:'已停止', error:'错误' };
      pill.textContent = labels[st.phase] || st.phase;
      bar.style.width = Math.max(2, st.progress || 0) + '%';
      msg.textContent = st.message || '';
      var busy = st.phase === 'installing' || st.phase === 'starting';
      bInstall.disabled = busy; bStart.disabled = busy || st.phase === 'running' || st.phase === 'not-installed';
      bStop.disabled = st.phase !== 'running' && st.phase !== 'starting';
      bUninstall.disabled = busy;
      if (busy) schedulePoll(1000); else schedulePoll(4000);
    }
    function refresh() { api('/api/omni/status').then(apply).catch(function () {}); }
    function schedulePoll(ms) {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = setTimeout(refresh, ms);
    }
    bInstall.addEventListener('click', function () {
      bInstall.disabled = true;
      post('/api/omni/install').then(function () { refresh(); })
        .catch(function (e) { msg.textContent = String(e.message || e); });
    });
    bStart.addEventListener('click', function () {
      bStart.disabled = true; post('/api/omni/start').then(refresh)
        .catch(function (e) { msg.textContent = String(e.message || e); bStart.disabled = false; });
    });
    bStop.addEventListener('click', function () { post('/api/omni/stop').then(refresh); });
    bUninstall.addEventListener('click', function () {
      if (window.confirm('确定卸载本地 OmniParser（将删除虚拟环境与权重）？')) {
        post('/api/omni/uninstall').then(refresh);
      }
    });
    refresh();
  }

  function setSaveStatus(text, ok) {
    var s = document.getElementById('saveStatus');
    s.textContent = text; s.className = 'save-status ' + (ok ? 'ok' : 'err');
    if (ok) setTimeout(function () { s.textContent = ''; s.className = 'save-status'; }, 2500);
  }

  function boot() {
    Promise.all([api('/api/meta'), api('/api/config')]).then(function (res) {
      var groups = res[0].groups, config = res[1];
      var root = document.getElementById('groups');
      groups.forEach(function (group) {
        var card = el('div', 'card');
        card.appendChild(el('h2', null, group.title));
        card.appendChild(el('p', 'gdesc', group.description));
        group.fields.forEach(function (field) {
          renderField(card, field, config[field.key]);
        });
        root.appendChild(card);
        if (group.id === 'omniparser') svcPanel(card);
      });
    }).catch(function (e) {
      document.getElementById('groups').textContent = '加载失败：' + (e.message || e);
    });
  }

  document.getElementById('save').addEventListener('click', function () {
    post('/api/config', readValues()).then(function () { setSaveStatus('已保存', true); })
      .catch(function (e) { setSaveStatus('保存失败：' + (e.message || e), false); });
  });
  document.getElementById('reset').addEventListener('click', function () {
    if (!window.confirm('恢复全部默认设置？')) return;
    post('/api/reset').then(function () {
      fieldRefs = {}; document.getElementById('groups').innerHTML = ''; boot();
      setSaveStatus('已恢复默认', true);
    });
  });

  boot();
})();
</script>
</body>
</html>`;
