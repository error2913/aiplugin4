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
    package_backends,
    save_config,
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
    --bg: #0e1116;
    --panel: #161b24;
    --panel-2: #1b2230;
    --border: #262f3d;
    --text: #e6ebf2;
    --muted: #8b96a8;
    --green: #34d399;
    --green-bg: rgba(52, 211, 153, .12);
    --red: #f87171;
    --red-bg: rgba(248, 113, 113, .12);
    --blue: #60a5fa;
    --blue-bg: rgba(96, 165, 250, .14);
    --amber: #fbbf24;
    --radius: 14px;
  }
  * { box-sizing: border-box; }
  body {
    font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    background: radial-gradient(1200px 600px at 20% -10%, #1a2334 0%, var(--bg) 55%);
    color: var(--text); margin: 0; min-height: 100vh; padding: 32px 28px 60px;
  }
  .wrap { max-width: 1200px; margin: 0 auto; }
  header { display: flex; align-items: center; gap: 14px; margin-bottom: 22px; }
  .logo {
    width: 44px; height: 44px; border-radius: 12px; flex: none;
    background: linear-gradient(135deg, #60a5fa, #a78bfa);
    display: flex; align-items: center; justify-content: center;
    font-size: 22px; box-shadow: 0 8px 24px rgba(96, 165, 250, .35);
  }
  h1 { font-size: 22px; margin: 0; font-weight: 700; letter-spacing: .3px; }
  .sub { color: var(--muted); font-size: 13px; margin-top: 3px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 18px; }
  .stat {
    background: linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,0));
    border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px;
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
  button:hover { background: #232c3d; border-color: #354152; }
  button:active { transform: scale(.97); }
  button.primary { background: var(--blue-bg); border-color: rgba(96,165,250,.45); color: #bfdbfe; }
  button.primary:hover { background: rgba(96,165,250,.22); }
  button.danger { background: var(--red-bg); border-color: rgba(248,113,113,.4); color: #fecaca; }
  button.danger:hover { background: rgba(248,113,113,.2); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 14px; }
  .card {
    background: linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,0));
    border: 1px solid var(--border); border-radius: var(--radius); padding: 16px;
    display: flex; flex-direction: column; gap: 12px; transition: border-color .2s ease, transform .2s ease;
  }
  .card:hover { border-color: #354152; transform: translateY(-2px); }
  .card.running { border-color: rgba(52,211,153,.35); }
  .row1 { display: flex; align-items: center; gap: 10px; }
  .name { font-family: Consolas, "Courier New", monospace; font-size: 15px; font-weight: 600; }
  .badge { font-size: 11px; padding: 3px 8px; border-radius: 999px; font-weight: 600; letter-spacing: .4px; }
  .badge.py { background: var(--blue-bg); color: #93c5fd; }
  .badge.node { background: rgba(52,211,153,.12); color: #6ee7b7; }
  .status { margin-left: auto; display: flex; align-items: center; gap: 6px; font-size: 12px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .dot.on { background: var(--green); box-shadow: 0 0 0 0 rgba(52,211,153,.5); animation: pulse 1.8s infinite; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(52,211,153,.45); } 70% { box-shadow: 0 0 0 7px rgba(52,211,153,0); } 100% { box-shadow: 0 0 0 0 rgba(52,211,153,0); } }
  .status.on { color: var(--green); }
  .status.off { color: var(--muted); }
  .desc { color: var(--muted); font-size: 12.5px; line-height: 1.5; min-height: 36px; }
  .meta { display: flex; gap: 8px; align-items: center; }
  .chip { font-family: Consolas, monospace; font-size: 12px; color: var(--amber); background: rgba(251,191,36,.08); border: 1px solid rgba(251,191,36,.25); padding: 3px 9px; border-radius: 8px; }
  .chip.idle { color: var(--muted); background: rgba(139,150,168,.08); border-color: rgba(139,150,168,.22); }
  .ops { display: flex; gap: 8px; flex-wrap: wrap; }
  .ops button { padding: 6px 12px; font-size: 12.5px; }
  .ops button.small { padding: 6px 10px; }
  .modal {
    position: fixed; inset: 0; background: rgba(5,8,12,.72); backdrop-filter: blur(4px);
    display: none; align-items: center; justify-content: center; z-index: 50; padding: 24px;
  }
  .modal.open { display: flex; }
  .dialog {
    width: min(860px, 100%); max-height: 82vh; background: var(--panel); border: 1px solid var(--border);
    border-radius: var(--radius); display: flex; flex-direction: column; overflow: hidden;
    box-shadow: 0 24px 60px rgba(0,0,0,.5);
  }
  .dialog-head { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--border); }
  .dialog-head b { font-size: 14px; }
  .dialog-head .spacer { flex: 1; }
  .dialog pre {
    margin: 0; padding: 16px 18px; overflow: auto; font-size: 12.5px; line-height: 1.55;
    font-family: Consolas, "Courier New", monospace; color: #b6c2d4; white-space: pre-wrap; word-break: break-all;
  }
  .close { background: transparent; border: none; font-size: 18px; color: var(--muted); cursor: pointer; padding: 2px 8px; }
  .close:hover { color: var(--text); }
  #toast {
    position: fixed; top: 20px; right: 20px; z-index: 99; max-width: 70vw;
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 10px;
    padding: 11px 16px; font-size: 13px; display: none; box-shadow: 0 12px 32px rgba(0,0,0,.45);
  }
  footer { margin-top: 26px; color: #5b6676; font-size: 12px; text-align: center; }
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
  </header>
  <div class="stats">
    <div class="stat"><b id="stTotal">0</b><span>后端总数</span></div>
    <div class="stat green"><b id="stRun">0</b><span>运行中</span></div>
    <div class="stat blue"><b id="stOn">0</b><span>已启用</span></div>
  </div>
  <div class="bar">
    <button class="primary" onclick="all('start')">▶ 启动全部</button>
    <button class="danger" onclick="all('stop')">■ 停止全部</button>
    <button onclick="pkg()">📦 打包后端 zip</button>
    <button onclick="refresh()">⟳ 刷新</button>
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
async function api(path, method){
  try {
    const r = await fetch(path, {method: method||'GET'});
    const j = await r.json();
    if (!j.ok) throw new Error(j.message || ('HTTP ' + r.status));
    return j;
  } catch(e){ toast('请求失败: ' + e.message); throw e; }
}
async function refresh(){
  const j = await api('/api/backends');
  const list = j.backends;
  document.getElementById('stTotal').textContent = list.length;
  document.getElementById('stRun').textContent = list.filter(b => b.running).length;
  document.getElementById('stOn').textContent = list.filter(b => b.enabled).length;
  document.getElementById('grid').innerHTML = list.map(b => `
    <div class="card ${b.running ? 'running' : ''}">
      <div class="row1">
        <span class="name">${esc(b.name)}</span>
        <span class="badge ${b.type === 'python' ? 'py' : 'node'}">${esc(b.type).toUpperCase()}</span>
        <span class="status ${b.running ? 'on' : 'off'}"><span class="dot ${b.running ? 'on' : ''}"></span>${b.running ? '运行中' : '已停止'}</span>
      </div>
      <div class="desc">${esc(b.description)}</div>
      <div class="meta">
        <span class="chip ${b.port ? '' : 'idle'}">:${b.port || '—'}</span>
        <span class="chip ${b.enabled ? '' : 'idle'}">${b.enabled ? '已启用' : '已停用'}</span>
        ${b.running && b.pid ? `<span class="chip idle">pid ${b.pid}</span>` : ''}
      </div>
      <div class="ops">
        <button onclick="toggle('${b.name}')">${b.enabled ? '停用' : '启用'}</button>
        <button onclick="setup('${b.name}')">安装依赖</button>
        ${b.running
          ? `<button class="danger" onclick="run('${b.name}','stop')">停止</button>`
          : `<button class="primary" onclick="run('${b.name}','start')">启动</button>`}
        <button class="small" onclick="showLog('${b.name}')">日志</button>
      </div>
    </div>`).join('');
}
async function toggle(name){ await api('/api/enable/' + name, 'POST'); toast('已更新启用状态'); refresh(); }
async function setup(name){ toast('开始安装依赖：' + name); await api('/api/setup/' + name, 'POST'); toast('安装完成：' + name); refresh(); }
async function run(name, act){ await api('/api/' + act + '/' + name, 'POST'); toast(act==='start' ? '已启动：' + name : '已停止：' + name); refresh(); }
async function all(act){ await api('/api/' + act + '-all', 'POST'); toast('已' + (act==='start'?'启动':'停止') + '全部'); refresh(); }
async function pkg(){ toast('打包已在后台开始，完成后见 dist/aiplugin4-backends-*.zip'); await api('/api/package', 'POST'); }
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
                enabled = set(config.get("enabled", []))
                rows = []
                for b in backends:
                    info = supervisor.state.get(b.name) or {}
                    rows.append({
                        "name": b.name,
                        "description": b.description,
                        "type": b.type,
                        "port": b.port,
                        "enabled": b.name in enabled,
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
                    supervisor.start([b for b in backends if b.name in config.get("enabled", [])])
                    self._json({"ok": True, "message": "started"})
                    return
                if path == "/api/stop-all":
                    supervisor.stop(backends)
                    self._json({"ok": True, "message": "stopped"})
                    return
                if path == "/api/package":
                    threading.Thread(target=lambda: (package_backends(), None), daemon=True).start()
                    self._json({"ok": True, "message": "packaging started"})
                    return
                parts = path.strip("/").split("/")
                if len(parts) == 3 and parts[0] == "api":
                    action, name = parts[1], parts[2]
                    backend = by_name.get(name)
                    if not backend:
                        self._err(f"未知后端: {name}", 404)
                        return
                    if action == "enable":
                        enabled = config.setdefault("enabled", [])
                        if name not in enabled:
                            enabled.append(name)
                        save_config(config)
                        self._json({"ok": True})
                        return
                    if action == "disable":
                        enabled = config.get("enabled", [])
                        if name in enabled:
                            enabled.remove(name)
                        save_config(config)
                        self._json({"ok": True})
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
