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
<title>aiplugin4 后端管理</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #12151b; color: #d7dde6; margin: 0; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #8b94a3; font-size: 13px; margin-bottom: 18px; }
  .bar { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
  button { background: #232a35; color: #d7dde6; border: 1px solid #39424f; border-radius: 6px; padding: 7px 14px; cursor: pointer; font-size: 13px; }
  button:hover { background: #2c3542; }
  button.primary { background: #2f6fed; border-color: #2f6fed; }
  button.danger { background: #b3403a; border-color: #b3403a; }
  table { width: 100%; border-collapse: collapse; background: #181d25; border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #232a35; font-size: 13px; }
  th { color: #8b94a3; font-weight: 600; }
  .run { color: #4ade80; }
  .stop { color: #8b94a3; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; }
  .tag.on { background: #1d3a2b; color: #4ade80; }
  .tag.off { background: #2a2f3a; color: #8b94a3; }
  .ops button { margin-right: 6px; padding: 4px 10px; }
  #logs { margin-top: 14px; background: #0d1015; border: 1px solid #232a35; border-radius: 8px; padding: 12px; display: none; }
  #logs pre { margin: 8px 0 0; white-space: pre-wrap; word-break: break-all; max-height: 360px; overflow: auto; font-size: 12px; color: #aab4c2; }
  #toast { position: fixed; top: 16px; right: 16px; background: #232a35; border: 1px solid #39424f; border-radius: 6px; padding: 10px 16px; font-size: 13px; display: none; max-width: 60vw; }
</style>
</head>
<body>
  <h1>aiplugin4 后端管理</h1>
  <div class="sub">launcher WebUI · 每 3 秒自动刷新状态 · 后端异常退出会自动拉起</div>
  <div class="bar">
    <button class="primary" onclick="all('start')">启动全部</button>
    <button class="danger" onclick="all('stop')">停止全部</button>
    <button onclick="pkg()">打包后端 zip</button>
    <button onclick="refresh()">刷新</button>
  </div>
  <table>
    <thead><tr><th>后端</th><th>端口</th><th>类型</th><th>状态</th><th>启用</th><th>操作</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <div id="logs"><b id="logTitle"></b><button onclick="loadLog()">刷新日志</button><pre id="logBody"></pre></div>
  <div id="toast"></div>
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
  const rows = document.getElementById('rows');
  rows.innerHTML = j.backends.map(b => `
    <tr>
      <td>${esc(b.name)}<br><span style="color:#8b94a3;font-size:12px">${esc(b.description)}</span></td>
      <td>${b.port}</td>
      <td>${esc(b.type)}</td>
      <td class="${b.running?'run':'stop'}">${b.running ? '运行中' : '已停止'}${b.running && b.pid ? ' (pid ' + b.pid + ')' : ''}</td>
      <td><span class="tag ${b.enabled?'on':'off'}">${b.enabled?'已启用':'已停用'}</span></td>
      <td class="ops">
        <button onclick="toggle('${b.name}')">${b.enabled?'停用':'启用'}</button>
        <button onclick="setup('${b.name}')">安装依赖</button>
        <button class="primary" onclick="run('${b.name}','start')">启动</button>
        <button class="danger" onclick="run('${b.name}','stop')">停止</button>
        <button onclick="showLog('${b.name}')">日志</button>
      </td>
    </tr>`).join('');
}
async function toggle(name){ await api('/api/enable/' + name, 'POST'); toast('已更新启用状态'); refresh(); }
async function setup(name){ toast('开始安装依赖：' + name); await api('/api/setup/' + name, 'POST'); toast('安装完成：' + name); refresh(); }
async function run(name, act){ await api('/api/' + act + '/' + name, 'POST'); toast(act==='start' ? '已启动：' + name : '已停止：' + name); refresh(); }
async function all(act){ await api('/api/' + act + '-all', 'POST'); toast('已' + (act==='start'?'启动':'停止') + '全部'); refresh(); }
async function pkg(){ toast('打包已在后台开始，完成后见 dist/aiplugin4-backends-*.zip'); await api('/api/package', 'POST'); refresh(); }
async function showLog(name){
  current = name;
  document.getElementById('logs').style.display = 'block';
  document.getElementById('logTitle').textContent = '日志：' + name;
  loadLog();
}
async function loadLog(){
  if (!current) return;
  const j = await api('/api/logs/' + current);
  document.getElementById('logBody').textContent = j.log || '(暂无日志)';
}
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
