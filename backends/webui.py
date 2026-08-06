#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
aiplugin4 后端 Web 管理界面（纯 Python 标准库，无第三方依赖）。

由 launcher.py webui 子命令启动：
  python launcher.py webui [--host 127.0.0.1] [--port 8910] [--no-browser]

默认只监听 127.0.0.1（本机），无鉴权，请勿暴露到公网。
"""

import json
import os
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from launcher import (
    DEFAULT_LOG_DIR,
    Supervisor,
    effective_port,
    load_runtime,
    save_runtime,
    setup_backend,
)

PAGE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>aiplugin4 后端管理</title>
<style>
  :root {
    --bg: #eef1f6; --panel: #ffffff; --panel-2: #f4f6fa;
    --border: #dde3ec; --text: #1d2635; --muted: #64748b;
    --green: #16a34a; --green-bg: rgba(22,163,74,.1);
    --red: #dc2626; --red-bg: rgba(220,38,38,.1);
    --blue: #2563eb; --blue-bg: rgba(37,99,235,.1);
    --amber: #b45309; --amber-bg: rgba(180,83,9,.1);
    --shadow: rgba(15,23,42,.08);
  }
  [data-theme="dark"] {
    --bg: #0e1116; --panel: #161b24; --panel-2: #1b2230;
    --border: #262f3d; --text: #e6ebf2; --muted: #8b96a8;
    --green: #34d399; --green-bg: rgba(52,211,153,.12);
    --red: #f87171; --red-bg: rgba(248,113,113,.12);
    --blue: #60a5fa; --blue-bg: rgba(96,165,250,.14);
    --amber: #fbbf24; --amber-bg: rgba(251,191,36,.1);
    --shadow: rgba(0,0,0,.45);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #0e1116; --panel: #161b24; --panel-2: #1b2230;
      --border: #262f3d; --text: #e6ebf2; --muted: #8b96a8;
      --green: #34d399; --green-bg: rgba(52,211,153,.12);
      --red: #f87171; --red-bg: rgba(248,113,113,.12);
      --blue: #60a5fa; --blue-bg: rgba(96,165,250,.14);
      --amber: #fbbf24; --amber-bg: rgba(251,191,36,.1);
      --shadow: rgba(0,0,0,.45);
    }
  }
  * { box-sizing: border-box; }
  body {
    font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    background: radial-gradient(1100px 520px at 18% -12%, color-mix(in srgb, var(--blue) 14%, transparent), transparent 60%), var(--bg);
    color: var(--text); margin: 0; min-height: 100vh; padding: 32px 28px 60px;
    transition: background .25s ease, color .25s ease;
  }
  .wrap { max-width: 1200px; margin: 0 auto; }
  header { display: flex; align-items: center; justify-content: center; gap: 14px; margin-bottom: 22px; position: relative; }
  .logo {
    width: 44px; height: 44px; border-radius: 12px; flex: none;
    background: linear-gradient(135deg, var(--blue), #a78bfa);
    display: flex; align-items: center; justify-content: center;
    font-size: 22px; box-shadow: 0 8px 24px color-mix(in srgb, var(--blue) 35%, transparent);
  }
  h1 { font-size: 22px; margin: 0; font-weight: 700; letter-spacing: .3px; }
  .sub { color: var(--muted); font-size: 13px; margin-top: 3px; }
  .header-right { position: absolute; right: 0; top: 50%; transform: translateY(-50%); display: flex; gap: 10px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 18px; }
  .stat {
    background: linear-gradient(180deg, color-mix(in srgb, var(--text) 4%, transparent), transparent);
    border: 1px solid var(--border); border-radius: 14px; padding: 14px 16px;
  }
  .stat b { font-size: 26px; display: block; line-height: 1.1; }
  .stat span { color: var(--muted); font-size: 12px; }
  .stat.green b { color: var(--green); }
  .stat.blue b { color: var(--blue); }
  .bar { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 20px; }
  button {
    background: var(--panel-2); color: var(--text); border: 1px solid var(--border);
    border-radius: 9px; padding: 8px 15px; cursor: pointer; font-size: 13px;
    transition: transform .12s ease, background .15s ease, border-color .15s ease;
  }
  button:hover { border-color: color-mix(in srgb, var(--muted) 50%, transparent); }
  button:active { transform: scale(.97); }
  button.primary { background: var(--blue-bg); border-color: color-mix(in srgb, var(--blue) 45%, transparent); color: var(--blue); }
  button.danger { background: var(--red-bg); border-color: color-mix(in srgb, var(--red) 40%, transparent); color: var(--red); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 14px; }
  .card {
    background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 16px;
    display: flex; flex-direction: column; gap: 12px; box-shadow: 0 1px 3px var(--shadow);
    transition: border-color .2s ease, transform .2s ease, box-shadow .2s ease;
  }
  .card:hover { border-color: color-mix(in srgb, var(--muted) 55%, transparent); transform: translateY(-2px); box-shadow: 0 8px 20px var(--shadow); }
  .card.running { border-color: color-mix(in srgb, var(--green) 40%, transparent); }
  .row1 { display: flex; align-items: center; gap: 10px; }
  .name { font-family: Consolas, "Courier New", monospace; font-size: 15px; font-weight: 600; }
  .badge { font-size: 11px; padding: 3px 8px; border-radius: 999px; font-weight: 600; letter-spacing: .4px; }
  .badge.py { background: var(--blue-bg); color: var(--blue); }
  .badge.node { background: var(--green-bg); color: var(--green); }
  .status { margin-left: auto; display: flex; align-items: center; gap: 6px; font-size: 12px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .dot.on { background: var(--green); animation: pulse 1.8s infinite; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--green) 45%, transparent); } 70% { box-shadow: 0 0 0 7px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
  .status.on { color: var(--green); }
  .status.off { color: var(--muted); }
  .desc { color: var(--muted); font-size: 12.5px; line-height: 1.5; min-height: 36px; }
  .meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .portbox { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
  .port {
    width: 76px; background: var(--panel-2); color: var(--text); border: 1px solid var(--border);
    border-radius: 8px; padding: 4px 8px; font-family: Consolas, monospace; font-size: 12.5px;
  }
  .port:focus { outline: none; border-color: var(--blue); }
  button.mini { padding: 4px 8px; font-size: 12px; }
  .chip { font-family: Consolas, monospace; font-size: 12px; color: var(--amber); background: var(--amber-bg); border: 1px solid color-mix(in srgb, var(--amber) 30%, transparent); padding: 3px 9px; border-radius: 8px; }
  .chip.idle { color: var(--muted); background: color-mix(in srgb, var(--muted) 10%, transparent); border-color: color-mix(in srgb, var(--muted) 22%, transparent); }
  .ops { display: flex; gap: 8px; flex-wrap: wrap; }
  .ops button { padding: 6px 12px; font-size: 12.5px; }
  .modal {
    position: fixed; inset: 0; background: rgba(5,8,12,.55); backdrop-filter: blur(4px);
    display: none; align-items: center; justify-content: center; z-index: 50; padding: 24px;
  }
  .modal.open { display: flex; }
  .dialog {
    width: min(860px, 100%); max-height: 82vh; background: var(--panel); border: 1px solid var(--border);
    border-radius: 14px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 24px 60px var(--shadow);
  }
  .dialog-head { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--border); }
  .dialog-head b { font-size: 14px; }
  .dialog-head .spacer { flex: 1; }
  .dialog pre {
    margin: 0; padding: 16px 18px; overflow: auto; font-size: 12.5px; line-height: 1.55;
    font-family: Consolas, "Courier New", monospace; color: var(--muted); white-space: pre-wrap; word-break: break-all;
  }
  .close { background: transparent; border: none; font-size: 18px; color: var(--muted); cursor: pointer; padding: 2px 8px; }
  #toast {
    position: fixed; top: 20px; left: 50%; transform: translateX(-50%); z-index: 99; max-width: 70vw;
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 10px;
    padding: 11px 16px; font-size: 13px; display: none; box-shadow: 0 12px 32px var(--shadow);
  }
  footer { margin-top: 26px; color: var(--muted); font-size: 12px; text-align: center; opacity: .7; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logo">🤖</div>
    <div>
      <h1>aiplugin4 后端管理</h1>
      <div class="sub">launcher WebUI · 每 3 秒自动刷新 · 后端异常退出会自动拉起</div>
    </div>
    <div class="header-right">
      <button id="themeBtn" onclick="cycleTheme()">主题</button>
      <button onclick="refresh()">⟳ 刷新</button>
    </div>
  </header>
  <div class="stats">
    <div class="stat"><b id="stTotal">0</b><span>后端总数</span></div>
    <div class="stat green"><b id="stRun">0</b><span>运行中</span></div>
  </div>
  <div class="bar">
    <button class="primary" onclick="all('start')">▶ 启动全部</button>
    <button class="danger" onclick="all('stop')">■ 停止全部</button>
  </div>
  <div class="grid" id="grid"></div>
</div>
<div class="modal" id="modal">
  <div class="dialog">
    <div class="dialog-head">
      <b id="logTitle">日志</b>
      <span class="spacer"></span>
      <button onclick="loadLog()">刷新日志</button>
      <button class="close" onclick="closeLog()">✕</button>
    </div>
    <pre id="logBody"></pre>
  </div>
</div>
<div id="toast"></div>
<footer>aiplugin4 · backends/launcher.py webui</footer>
<script>
let current = null;
function esc(s){ return (s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.style.display='block'; clearTimeout(t._h); t._h=setTimeout(()=>t.style.display='none', 3000); }
async function api(path, method, body){
  try {
    const r = await fetch(path, {method: method||'GET', body: body || undefined});
    const j = await r.json();
    if (!j.ok) throw new Error(j.message || ('HTTP ' + r.status));
    return j;
  } catch(e){ toast('请求失败: ' + e.message); throw e; }
}
function applyTheme(){
  const t = localStorage.getItem('theme') || 'auto';
  document.documentElement.dataset.theme = t === 'auto' ? '' : t;
  document.getElementById('themeBtn').textContent = t === 'auto' ? '🌓 主题：跟随系统' : (t === 'light' ? '☀️ 主题：浅色' : '🌙 主题：深色');
}
function cycleTheme(){
  const cur = localStorage.getItem('theme') || 'auto';
  const next = cur === 'auto' ? 'light' : cur === 'light' ? 'dark' : 'auto';
  localStorage.setItem('theme', next);
  applyTheme();
}
async function refresh(){
  const j = await api('/api/backends');
  const list = j.backends;
  document.getElementById('stTotal').textContent = list.length;
  document.getElementById('stRun').textContent = list.filter(b => b.running).length;
  document.getElementById('grid').innerHTML = list.map(b => `
    <div class="card ${b.running ? 'running' : ''}">
      <div class="row1">
        <span class="name">${esc(b.name)}</span>
        <span class="badge ${b.type === 'python' ? 'py' : 'node'}">${esc(b.type).toUpperCase()}</span>
        <span class="status ${b.running ? 'on' : 'off'}"><span class="dot ${b.running ? 'on' : ''}"></span>${b.running ? '运行中' : '已停止'}</span>
      </div>
      <div class="desc">${esc(b.description)}</div>
      <div class="meta">
        <span class="portbox">端口 <input class="port" type="number" min="1" max="65535" value="${b.port}" onchange="setPort('${b.name}', this.value)" title="修改后重启后端生效"></span>
        <button class="mini" onclick="resetPort('${b.name}')" title="恢复默认端口">↺</button>
        ${b.running && b.pid ? `<span class="chip idle">pid ${b.pid}</span>` : ''}
      </div>
      <div class="ops">
        <button onclick="setup('${b.name}')">安装依赖</button>
        ${b.running
          ? `<button class="danger" onclick="run('${b.name}','stop')">停止</button>`
          : `<button class="primary" onclick="run('${b.name}','start')">启动</button>`}
        <button onclick="showLog('${b.name}')">日志</button>
      </div>
    </div>`).join('');
}
async function setup(name){ toast('开始安装依赖：' + name); await api('/api/setup/' + name, 'POST'); toast('安装完成：' + name); refresh(); }
async function run(name, act){ await api('/api/' + act + '/' + name, 'POST'); toast(act==='start' ? '已启动：' + name : '已停止：' + name); refresh(); }
async function all(act){ await api('/api/' + act + '-all', 'POST'); toast('已' + (act==='start'?'启动':'停止') + '全部'); refresh(); }
async function setPort(name, val){
  const n = parseInt(val, 10);
  if (!n || n < 1 || n > 65535){ toast('端口必须是 1-65535'); refresh(); return; }
  await api('/api/port/' + name, 'POST', JSON.stringify({port: n}));
  toast('端口已保存：' + name + ' → ' + n + '（重启后端生效）');
  refresh();
}
async function resetPort(name){ await api('/api/port/' + name + '/reset', 'POST'); toast('已恢复默认端口'); refresh(); }
async function showLog(name){
  current = name;
  document.getElementById('logTitle').textContent = '日志：' + name;
  document.getElementById('modal').classList.add('open');
  await loadLog();
}
function closeLog(){ document.getElementById('modal').classList.remove('open'); current = null; }
async function loadLog(){
  if (!current) return;
  const j = await api('/api/logs/' + current);
  const pre = document.getElementById('logBody');
  pre.textContent = j.log || '(暂无日志)';
  pre.scrollTop = pre.scrollHeight;
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLog(); });
applyTheme();
refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>"""


def run_webui(backends, config, supervisor: Supervisor, host: str = "127.0.0.1", port: int = 8910, open_browser: bool = True) -> None:
    """启动 Web 管理界面（阻塞，Ctrl+C 退出）"""
    log_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), config.get("log_dir", DEFAULT_LOG_DIR))
    by_name = {b.name: b for b in backends}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # 关闭默认访问日志刷屏
            pass

        def _json(self, obj, status=200):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _err(self, message, status=500):
            self._json({"ok": False, "message": message}, status)

        def _read_json(self) -> dict:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            try:
                return json.loads(raw or b"{}")
            except ValueError:
                return {}

        def do_GET(self):
            if self.path == "/":
                body = PAGE.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if self.path == "/api/backends":
                rows = []
                for b in backends:
                    info = supervisor.state.get(b.name) or {}
                    rows.append({
                        "name": b.name,
                        "description": b.description,
                        "type": b.type,
                        "port": effective_port(b),
                        "default_port": b.port,
                        "running": supervisor.is_running(b.name),
                        "pid": info.get("pid"),
                    })
                self._json({"ok": True, "backends": rows})
                return
            if self.path.startswith("/api/logs/"):
                name = self.path[len("/api/logs/"):]
                log_file = os.path.join(log_dir, name + ".log")
                try:
                    with open(log_file, encoding="utf-8", errors="replace") as f:
                        lines = f.readlines()
                    self._json({"ok": True, "log": "".join(lines[-300:])})
                except OSError:
                    self._json({"ok": True, "log": ""})
                return
            self._err("not found", 404)

        def do_POST(self):
            path = self.path
            try:
                if path == "/api/start-all":
                    supervisor.start(backends)
                    self._json({"ok": True, "message": "started"})
                    return
                if path == "/api/stop-all":
                    supervisor.stop(backends)
                    self._json({"ok": True, "message": "stopped"})
                    return
                if path.startswith("/api/port/"):
                    rest = path[len("/api/port/"):]
                    if rest.endswith("/reset"):
                        name = rest[:-len("/reset")]
                        backend = by_name.get(name)
                        if not backend:
                            self._err(f"未知后端: {name}", 404)
                            return
                        runtime = load_runtime()
                        runtime.setdefault("ports", {}).pop(name, None)
                        save_runtime(runtime)
                        self._json({"ok": True, "port": backend.port})
                        return
                    name = rest
                    backend = by_name.get(name)
                    if not backend:
                        self._err(f"未知后端: {name}", 404)
                        return
                    value = self._read_json().get("port")
                    try:
                        value = int(value)
                    except (TypeError, ValueError):
                        self._err("端口必须是 1-65535 的整数", 400)
                        return
                    if not 1 <= value <= 65535:
                        self._err("端口必须是 1-65535 的整数", 400)
                        return
                    runtime = load_runtime()
                    runtime.setdefault("ports", {})[name] = value
                    save_runtime(runtime)
                    self._json({"ok": True, "port": value})
                    return
                parts = path.strip("/").split("/")
                if len(parts) == 3 and parts[0] == "api":
                    action, name = parts[1], parts[2]
                    backend = by_name.get(name)
                    if not backend:
                        self._err(f"未知后端: {name}", 404)
                        return
                    if action == "setup":
                        setup_backend(backend)
                        self._json({"ok": True, "message": "setup done"})
                        return
                    if action == "start":
                        if name in supervisor.state.get("stopped", []):
                            supervisor.state["stopped"].remove(name)
                            supervisor._save_state()
                        supervisor.start([backend])
                        self._json({"ok": True})
                        return
                    if action == "stop":
                        supervisor.stop([backend])
                        self._json({"ok": True})
                        return
                self._err("not found", 404)
            except Exception as e:  # noqa: BLE001
                self._err(str(e))

    server = ThreadingHTTPServer((host, port), Handler)
    print(f"[launcher] WebUI 已启动: http://{host}:{port}（Ctrl+C 退出）")
    if open_browser:
        threading.Timer(0.5, lambda: webbrowser.open(f"http://{host}:{port}")).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[launcher] WebUI 已停止")
    finally:
        server.server_close()
