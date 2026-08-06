#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
aiplugin4 后端一键配置与启动器（仅依赖 Python 标准库，纯命令行管理）。

子命令：
  list                        列出后端与运行状态
  setup [name...|--all]       安装依赖（幂等；默认不自动安装，仅首次启动时按需安装）
  port <name> [value|reset]   查看/修改后端端口（写入 .runtime.json，重启后端生效）
  start <name...>|--all       启动后端（需显式指定；首次启动该后端时自动创建 venv /
                              安装依赖，进程异常退出会自动拉起）
  stop [name...|--all]        停止后端（默认停止全部）
  status                      查看运行状态
  package                     打包 backends/ 为 dist/aiplugin4-backends-<版本>.zip

示例：
  python launcher.py list
  python launcher.py setup --all
  python launcher.py start --all
  python launcher.py start stream-output web-read
  python launcher.py stop --all
  python launcher.py status
  python launcher.py package
"""

import argparse
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import zipfile
from dataclasses import dataclass

BACKENDS_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(BACKENDS_DIR)
CONFIG_FILE = os.path.join(BACKENDS_DIR, "launcher.json")
MANIFEST_FILE = "backend.json"
DEFAULT_LOG_DIR = "logs"
RUNTIME_FILE = ".runtime.json"
VENV_DIR_NAME = ".venv"
DEPS_MARKER = ".deps_ready"

# 打包时排除的目录/文件
EXCLUDE_DIRS = {"logs", "node_modules", "__pycache__", ".venv", "venv", "dist", ".git"}
EXCLUDE_SUFFIXES = (".pyc", ".pyo")


@dataclass
class Backend:
    name: str
    description: str
    type: str  # python | node
    entry: str
    deps: str
    port: int
    dir: str


def load_config() -> dict:
    if not os.path.exists(CONFIG_FILE):
        return {"auto_restart": True, "restart_backoff_seconds": [2, 5, 10, 30], "log_dir": DEFAULT_LOG_DIR}
    with open(CONFIG_FILE, encoding="utf-8") as f:
        return json.load(f)


def save_config(config: dict) -> None:
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)


def load_runtime() -> dict:
    """运行时配置（端口覆盖等），位于 backends/.runtime.json，不随源码提交"""
    try:
        with open(os.path.join(BACKENDS_DIR, RUNTIME_FILE), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_runtime(runtime: dict) -> None:
    with open(os.path.join(BACKENDS_DIR, RUNTIME_FILE), "w", encoding="utf-8") as f:
        json.dump(runtime, f, ensure_ascii=False, indent=2)


def effective_port(backend: Backend) -> int:
    """有效端口：优先 .runtime.json 中的覆盖值，否则用 backend.json 默认值"""
    return int(load_runtime().get("ports", {}).get(backend.name, backend.port))


def discover_backends() -> list:
    backends = []
    for entry in sorted(os.listdir(BACKENDS_DIR)):
        manifest = os.path.join(BACKENDS_DIR, entry, MANIFEST_FILE)
        if not os.path.isfile(manifest):
            continue
        with open(manifest, encoding="utf-8") as f:
            data = json.load(f)
        backends.append(Backend(
            name=data["name"],
            description=data.get("description", ""),
            type=data.get("type", "python"),
            entry=data.get("entry", ""),
            deps=data.get("deps", ""),
            port=int(data.get("port", 0)),
            dir=os.path.join(BACKENDS_DIR, entry),
        ))
    return backends


def venv_python_path(backend_dir: str) -> str:
    if os.name == "nt":
        return os.path.join(backend_dir, VENV_DIR_NAME, "Scripts", "python.exe")
    return os.path.join(backend_dir, VENV_DIR_NAME, "bin", "python")


def deps_hash(backend: Backend) -> str:
    dep_file = os.path.join(backend.dir, backend.deps)
    try:
        with open(dep_file, "rb") as f:
            return hashlib.md5(f.read()).hexdigest()
    except OSError:
        return ""


def ensure_venv(backend: Backend) -> str:
    """为 python 后端创建/复用独立 venv 并按需安装依赖，返回 venv 内的 python 路径"""
    py = venv_python_path(backend.dir)
    marker = os.path.join(backend.dir, VENV_DIR_NAME, DEPS_MARKER)
    current = deps_hash(backend)
    if os.path.isfile(py):
        try:
            with open(marker, encoding="utf-8") as f:
                if f.read().strip() == current:
                    return py
        except OSError:
            pass
        print(f"[launcher] {backend.name} 依赖清单有变化，重新安装")
    else:
        print(f"[launcher] {backend.name} 首次运行，创建独立虚拟环境...")
        subprocess.check_call([sys.executable, "-m", "venv", os.path.join(backend.dir, VENV_DIR_NAME)])
    if not current:
        print(f"[launcher] 跳过 {backend.name}: 缺少 {backend.deps}")
    else:
        subprocess.check_call([py, "-m", "pip", "install", "-r", os.path.join(backend.dir, backend.deps)])
    with open(marker, "w", encoding="utf-8") as f:
        f.write(current)
    return py


def ensure_node(backend: Backend) -> str:
    """为 node 后端确保 node_modules 存在（缺失时 npm install）"""
    if not os.path.isdir(os.path.join(backend.dir, "node_modules")):
        print(f"[launcher] {backend.name} 首次运行，npm install...")
        subprocess.check_call(["npm", "install"], cwd=backend.dir)
    return "node"


def ensure_environment(backend: Backend) -> list:
    """一键启动：确保依赖就绪，返回启动命令前缀（python 用 venv 内解释器）"""
    if backend.type == "python":
        return [ensure_venv(backend)]
    return [ensure_node(backend)]


class Supervisor:
    """后端进程监督：启动子进程、写日志、异常退出自动拉起（带退避）；
    运行状态持久化到 logs/state.json，支持跨终端 stop/status 管理"""

    def __init__(self, config: dict):
        self.config = config
        self.procs = {}
        self.stop_flags = {}
        self.restart_count = {}
        self.log_dir = os.path.join(BACKENDS_DIR, config.get("log_dir", DEFAULT_LOG_DIR))
        os.makedirs(self.log_dir, exist_ok=True)
        self.state_file = os.path.join(self.log_dir, "state.json")
        self.state = self._load_state()

    def _load_state(self) -> dict:
        try:
            with open(self.state_file, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return {}

    def _save_state(self) -> None:
        with open(self.state_file, "w", encoding="utf-8") as f:
            json.dump(self.state, f, ensure_ascii=False, indent=2)

    def _reload_state(self) -> None:
        """读写前重载 state 文件，避免覆盖其他进程（stop/status）写入的内容"""
        try:
            with open(self.state_file, encoding="utf-8") as f:
                self.state = json.load(f)
        except (OSError, ValueError):
            self.state = {}

    @staticmethod
    def _pid_alive(pid: int) -> bool:
        if not pid:
            return False
        if os.name == "nt":
            import ctypes
            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if handle:
                ctypes.windll.kernel32.CloseHandle(handle)
                return True
            return ctypes.windll.kernel32.GetLastError() == 5  # ERROR_ACCESS_DENIED: 进程存在但无权限
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        except OSError:
            return False

    def is_running(self, name: str) -> bool:
        self._reload_state()
        proc = self.procs.get(name)
        if proc is not None:
            return proc.poll() is None
        info = self.state.get(name)
        if info and self._pid_alive(info.get("pid")):
            return True
        if info:
            self.state.pop(name, None)
            self._save_state()
        return False

    def spawn(self, backend: Backend) -> bool:
        self._reload_state()
        if self.is_running(backend.name):
            return False
        log_path = os.path.join(self.log_dir, f"{backend.name}.log")
        log_file = open(log_path, "a", encoding="utf-8")
        log_file.write(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} 启动 {backend.name} (port {backend.port}) =====\n")
        log_file.flush()
        # 强制子进程以 UTF-8 输出，避免 Windows 下 GBK 与 launcher 的 UTF-8 日志混编码导致乱码
        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"] = "1"
        env["AIPLUGIN4_BACKEND_PORT"] = str(effective_port(backend))
        proc = subprocess.Popen(
            ensure_environment(backend) + [backend.entry],
            cwd=backend.dir,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            env=env,
        )
        self.procs[backend.name] = proc
        self.state[backend.name] = {"pid": proc.pid, "started_at": time.strftime("%Y-%m-%d %H:%M:%S")}
        self._save_state()
        print(f"[launcher] 已启动 {backend.name} (pid={proc.pid}, port={backend.port}, 日志={log_path})")
        return True

    def _monitor(self, backend: Backend) -> None:
        while True:
            self._reload_state()
            proc = self.procs.get(backend.name)
            if proc is None:
                return
            proc.wait()
            self._reload_state()
            if self.stop_flags.get(backend.name, threading.Event()).is_set():
                self.state.pop(backend.name, None)
                self._save_state()
                return
            if self.procs.get(backend.name) is not proc:
                return
            del self.procs[backend.name]
            self.state.pop(backend.name, None)
            self._save_state()
            self.restart_count[backend.name] = self.restart_count.get(backend.name, 0) + 1
            if backend.name in self.state.get("stopped", []):
                print(f"[launcher] {backend.name} 已停止，不再自动拉起")
                return
            if not self.config.get("auto_restart", True):
                print(f"[launcher] {backend.name} 已退出（自动重启已关闭）")
                return
            backoffs = self.config.get("restart_backoff_seconds", [2, 5, 10, 30])
            delay = backoffs[min(self.restart_count[backend.name] - 1, len(backoffs) - 1)]
            print(f"[launcher] {backend.name} 异常退出，{delay}s 后自动拉起（第 {self.restart_count[backend.name]} 次）")
            time.sleep(delay)
            self._reload_state()
            if self.stop_flags.get(backend.name, threading.Event()).is_set():
                return
            if backend.name in self.state.get("stopped", []):
                print(f"[launcher] {backend.name} 已停止，不再自动拉起")
                return
            self.spawn(backend)

    def start(self, backends: list) -> None:
        for backend in backends:
            self.stop_flags[backend.name] = threading.Event()
            self.spawn(backend)
            threading.Thread(target=self._monitor, args=(backend,), daemon=True).start()

    def stop(self, backends: list) -> None:
        for backend in backends:
            self._reload_state()
            flag = self.stop_flags.setdefault(backend.name, threading.Event())
            flag.set()
            proc = self.procs.get(backend.name)
            if proc and proc.poll() is None:
                print(f"[launcher] 停止 {backend.name} (pid={proc.pid})")
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
            else:
                info = self.state.get(backend.name)
                if info and self._pid_alive(info.get("pid")):
                    print(f"[launcher] 停止 {backend.name} (pid={info['pid']})")
                    try:
                        os.kill(info["pid"], signal.SIGTERM)
                    except OSError:
                        pass
            self.procs.pop(backend.name, None)
            self.state.pop(backend.name, None)
            if backend.name not in self.state.setdefault("stopped", []):
                self.state["stopped"].append(backend.name)
            self._save_state()
            self.restart_count[backend.name] = 0

    def status(self, backends: list) -> None:
        running = 0
        for backend in backends:
            ok = self.is_running(backend.name)
            running += ok
            state = "[运行中]" if ok else "[已停止]"
            print(f"{state} {backend.name:24s} port={effective_port(backend):<6d} {backend.description}")
        print(f"共 {running}/{len(backends)} 个后端在运行")


def setup_backend(backend: Backend) -> None:
    """安装依赖（幂等，python 后端装入独立 venv）"""
    if backend.type == "python":
        ensure_venv(backend)
    else:
        ensure_node(backend)


def read_version() -> str:
    try:
        with open(os.path.join(ROOT_DIR, "src", "config", "static_config.ts"), encoding="utf-8") as f:
            src = f.read()
        m = re.search(r'VERSION\s*=\s*["\']([^"\']+)["\']', src)
        if m:
            return m.group(1)
    except OSError:
        pass
    return "0.0.0"


def package_backends() -> str:
    version = read_version()
    out_dir = os.path.join(ROOT_DIR, "dist")
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, f"aiplugin4-backends-{version}.zip")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(BACKENDS_DIR):
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
            for name in files:
                if name.endswith(EXCLUDE_SUFFIXES):
                    continue
                path = os.path.join(root, name)
                arcname = os.path.relpath(path, ROOT_DIR)
                zf.write(path, arcname)
    print(f"[launcher] 已打包后端: {out}")
    return out


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="launcher",
        description="aiplugin4 后端一键配置与启动器（纯命令行管理）",
    )
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("list", help="列出后端与启用/运行状态")
    setup_p = sub.add_parser("setup", help="安装依赖（幂等，python 后端装入独立 venv）")
    setup_p.add_argument("names", nargs="*")
    setup_p.add_argument("--all", action="store_true", help="安装全部后端")
    port_p = sub.add_parser("port", help="查看/修改后端端口（重启后端生效）")
    port_p.add_argument("name")
    port_p.add_argument("value", nargs="?", help="新端口(1-65535)，或 reset 恢复默认")
    start_p = sub.add_parser("start", help="启动后端（首次自动创建 venv 并安装依赖）")
    start_p.add_argument("names", nargs="*")
    start_p.add_argument("--all", action="store_true", help="启动全部后端")
    start_p.add_argument("--background", action="store_true", help="后台运行（Linux 用 setsid，Windows 用 DETACHED_PROCESS）")
    sub.add_parser("stop", help="停止后端").add_argument("names", nargs="*")
    sub.add_parser("status", help="查看运行状态")
    sub.add_parser("package", help="打包 backends/ 为 zip")
    webui_p = sub.add_parser("webui", help="启动 Web 管理界面")
    webui_p.add_argument("--host", default="127.0.0.1", help="监听地址（默认 127.0.0.1，仅本机）")
    webui_p.add_argument("--port", type=int, default=8910, help="监听端口（默认 8910）")
    webui_p.add_argument("--no-browser", action="store_true", help="启动后不自动打开浏览器")
    args = parser.parse_args()

    config = load_config()
    backends = discover_backends()
    supervisor = Supervisor(config)

    if not args.command:
        parser.print_help()
        return

    by_name = {b.name: b for b in backends}

    def find(names: list) -> list:
        missing = [n for n in names if n not in by_name]
        if missing:
            print(f"[launcher] 未知后端: {', '.join(missing)}（可用: {', '.join(by_name)}）")
            sys.exit(1)
        return [by_name[n] for n in names]

    if args.command == "list":
        for backend in backends:
            state = "运行中" if supervisor.is_running(backend.name) else "已停止"
            print(f"{backend.name:24s} port={effective_port(backend):<6d} [{state}] {backend.description}")
        return

    if args.command == "setup":
        targets = backends if args.all else find(args.names) if args.names else []
        if not targets:
            print("[launcher] 请指定后端名称或使用 --all 安装全部")
            return
        for backend in targets:
            setup_backend(backend)
        return

    if args.command == "port":
        backend = find([args.name])[0]
        runtime = load_runtime()
        ports = runtime.setdefault("ports", {})
        if args.value is None:
            print(f"{backend.name} 端口: {effective_port(backend)}（默认 {backend.port}）")
            return
        if args.value == "reset":
            ports.pop(backend.name, None)
            save_runtime(runtime)
            print(f"{backend.name} 端口已恢复默认 {backend.port}")
            return
        try:
            value = int(args.value)
        except ValueError:
            print("[launcher] 端口必须是 1-65535 的整数")
            sys.exit(1)
        if not 1 <= value <= 65535:
            print("[launcher] 端口必须是 1-65535 的整数")
            sys.exit(1)
        ports[backend.name] = value
        save_runtime(runtime)
        print(f"{backend.name} 端口已设为 {value}（重启后端后生效）")
        return

    if args.command == "start":
        if args.background:
            script = os.path.abspath(__file__)
            cmd = [sys.executable, script, "start"] + list(args.names)
            if args.all:
                cmd.append("--all")
            kwargs = {}
            if os.name == "nt":
                kwargs["creationflags"] = (
                    subprocess.CREATE_NEW_PROCESS_GROUP
                    | subprocess.DETACHED_PROCESS
                    | subprocess.CREATE_NO_WINDOW
                )
            else:
                kwargs["start_new_session"] = True
            subprocess.Popen(
                cmd,
                cwd=BACKENDS_DIR,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                **kwargs
            )
            print("[launcher] 已在后台启动，可用 stop/status 管理")
            return
        if args.names:
            targets = find(args.names)
        elif args.all:
            targets = backends
        else:
            print("[launcher] 请指定后端名称或使用 --all 启动全部（默认不启动任何后端）")
            return
        for backend in targets:
            if backend.name in supervisor.state.setdefault("stopped", []):
                supervisor.state["stopped"].remove(backend.name)  # 手动启动清除停止标记
        supervisor._save_state()
        supervisor.start(targets)
        print("后端已启动，按 Ctrl+C 停止全部")
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            supervisor.stop(targets)
            print("\n全部已停止")
        return

    if args.command == "stop":
        supervisor.stop(find(args.names) if args.names else backends)
        return

    if args.command == "status":
        supervisor.status(backends)
        return

    if args.command == "package":
        package_backends()
        return

    if args.command == "webui":
        try:
            from webui import run_webui
        except ImportError:
            print("[launcher] webui 模块缺失（backends/webui.py）")
            sys.exit(1)
        run_webui(backends, config, supervisor, host=args.host, port=args.port, open_browser=not args.no_browser)
        return

    parser.error(f"未知命令: {args.command}")


if __name__ == "__main__":
    main()
