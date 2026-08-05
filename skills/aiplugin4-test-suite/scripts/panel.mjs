#!/usr/bin/env node
/**
 * SealDice panel automation: unlock / logs / open-js / plugins / screenshot /
 * inspect / click / set-input / steps / reload / upload-reload.
 * Run with Node 22+: C:\Users\26335\.codex\tools\node-v22.23.2-win-x64\node.exe
 * Sensitive config (panel URL + unlock token) is NEVER hardcoded here;
 * it is read from env vars:
 *   $env:SEALDICE_PANEL_URL="http://host:port"
 *   $env:SEALDICE_PANEL_PASSWORD="secret"   (or SEALDICE_PANEL_TOKEN)
 * Usage:
 *   node panel.mjs unlock
 *   node panel.mjs logs [--limit N]
 *   node panel.mjs open-js
 *   node panel.mjs plugins
 *   node panel.mjs screenshot [--route /mod/js]
 *   node panel.mjs inspect
 *   node panel.mjs click <text>
 *   node panel.mjs set-input <label> <value>
 *   node panel.mjs steps --file steps.json
 *   node panel.mjs reload
 *   node panel.mjs upload-reload [--file dist/aiplugin4.js]
 * Safety: never upload plugins or reload JS without explicit user approval;
 * at least 60 seconds must pass between reloads.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { puppeteer } from "file:///C:/Users/26335/Desktop/chrome-devtools-mcp/node_modules/chrome-devtools-mcp/build/src/third_party/index.js";

// 优先从技能目录的 .env 读取凭据（该文件已 gitignore，不会提交）；缺失时回退到环境变量
{
  const envFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf-8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  }
}

const PANEL = process.env.SEALDICE_PANEL_URL;
const PASSWORD = process.env.SEALDICE_PANEL_PASSWORD || process.env.SEALDICE_PANEL_TOKEN;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT = process.cwd();
const DEFAULT_PLUGIN = "C:\\Users\\26335\\Documents\\GitHub\\aiplugin4\\dist\\aiplugin4.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argValue = (args, name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

async function unlock(page) {
  await page.goto(PANEL + "/#/home", { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(3000);
  const locked = await page.evaluate(() => document.body.innerText.includes("输入密码解锁"));
  if (!locked) return;
  await page.$eval("input[type=password]", (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, PASSWORD);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("确认") || b.textContent.includes("确"));
    if (btn) btn.click();
  });
  await sleep(4000);
  const stillLocked = await page.evaluate(() => document.body.innerText.includes("输入密码解锁"));
  if (stillLocked) throw new Error("unlock failed: wrong password or lock still present");
}

async function clickText(page, text) {
  return page.evaluate((t) => {
    const sel = "button, [role=tab], .el-tabs__item, .el-radio-button, a, .el-switch, .el-checkbox, .el-card, .el-collapse-item__header, .el-collapse-item__title";
    let els = [...document.querySelectorAll(sel)].filter((el) => {
      const txt = (el.textContent || "").trim();
      return txt === t || txt.includes(t) || (el.title || "").includes(t);
    });
    const visible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
    els = els.filter(visible);
    if (els.length === 0) {
      els = [...document.querySelectorAll("span, div, li")].filter((el) => {
        const txt = (el.textContent || "").trim();
        return txt === t && visible(el) && el.children.length <= 2;
      });
    }
    if (els.length === 0) return false;
    els.sort((a, b) => {
      const ae = (a.textContent || "").trim() === t ? 0 : 1;
      const be = (b.textContent || "").trim() === t ? 0 : 1;
      if (ae !== be) return ae - be;
      const at = a.matches("[role=tab], .el-tabs__item") ? 0 : 1;
      const bt = b.matches("[role=tab], .el-tabs__item") ? 0 : 1;
      return at - bt;
    });
    els[0].click();
    return true;
  }, text);
}

async function setInputByLabel(page, label, value) {
  return page.evaluate(({ label, value }) => {
    const inputs = [...document.querySelectorAll("input, textarea")];
    const pick =
      inputs.find((el) => {
        const ctx = (el.closest(".el-form-item, label, .el-form") || el).textContent || "";
        const ph = el.placeholder || "";
        return ctx.includes(label) || ph.includes(label);
      }) ||
      inputs.find((el) => ((el.previousElementSibling || {}).textContent || "").includes(label));
    if (!pick) return false;
    const proto = pick.tagName === "TEXTAREA" ? HTMLTextAreaElement : HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value").set;
    setter.call(pick, value);
    pick.dispatchEvent(new Event("input", { bubbles: true }));
    pick.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, { label, value });
}

async function dumpPage(page) {
  return page.evaluate(() => {
    const vis = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
    const tabs = [...document.querySelectorAll(".el-tabs__item, [role=tab]")]
      .map((t) => t.textContent.trim()).filter(Boolean);
    const activeTab = [...document.querySelectorAll(".el-tabs__item, [role=tab]")]
      .filter((t) => t.className.includes("is-active") || t.getAttribute("aria-selected") === "true")
      .map((t) => t.textContent.trim());
    const buttons = [...document.querySelectorAll("button")]
      .map((b) => b.textContent.trim()).filter(Boolean).slice(0, 100);
    const labels = [...document.querySelectorAll(".el-form-item__label, label, .el-descriptions__label")]
      .map((l) => l.textContent.trim()).filter(Boolean).slice(0, 100);
    const inputs = [...document.querySelectorAll("input, textarea")].filter(vis).map((el) => ({
      type: el.type,
      placeholder: el.placeholder || "",
      value: el.value,
    })).slice(0, 100);
    const items = [...document.querySelectorAll(".el-form-item")].filter(vis).map((it) => ({
      label: ((it.querySelector(".el-form-item__label") || {}).textContent || "").trim(),
      value: ((it.querySelector("input, textarea") || {}).value ?? ""),
    })).filter((i) => i.label).slice(0, 100);
    const collapseHeaders = [...document.querySelectorAll(".el-collapse-item__header")]
      .map((h) => (h.textContent || "").trim().replace(/\s+/g, " ")).filter(Boolean).slice(0, 40);
    const saves = [...document.querySelectorAll("*")]
      .filter((el) => /点我保存|保存|Save/.test(el.textContent.trim()) && el.textContent.trim().length < 20)
      .map((el) => el.tagName + "|" + (el.className || "") + "|" + el.textContent.trim() + "|vis=" + vis(el))
      .slice(0, 20);
    return { url: location.href, tabs, activeTab, buttons, labels, inputs, items, collapseHeaders, saves };
  });
}

async function gotoJs(page) {
  await page.goto(PANEL + "/#/mod/js", { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(3500);
}

async function uploadPlugin(page, file) {
  await gotoJs(page);
  const input = await page.$("input[type=file]");
  if (!input) throw new Error("no file input found on #/mod/js");
  await input.uploadFile(file);
  await sleep(1000);
  const clicked = await clickText(page, "上传插件");
  if (!clicked) throw new Error("上传插件 button not found");
  await sleep(6000); // 等待上传完成数秒后再重载
  console.log("UPLOAD_OK " + file);
}

async function reloadJs(page) {
  await gotoJs(page);
  const clicked = await clickText(page, "重载 JS");
  if (!clicked) throw new Error("重载 JS button not found");
  await sleep(6000);
  console.log("RELOAD_OK");
}

function fmtTime(ts) {
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function cleanMsg(msg) {
  return msg
    .replace(/<CQ:image,file=[^>]*>/g, " [图片] ")
    .replace(/<CQ:reply,id=\d+>/g, " [回复] ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function runSteps(page, steps) {
  const dumps = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.type === "wait") {
      await sleep(parseInt(s.ms || 1000, 10));
    } else if (s.type === "scroll") {
      await page.evaluate((y) => {
        window.scrollTo(0, y);
        document.documentElement.scrollTop = y;
        document.body.scrollTop = y;
      }, parseInt(s.y || 100000, 10));
      await sleep(1500);
    } else if (s.type === "click") {
      const ok = await clickText(page, s.text);
      console.log("STEP click " + s.text + " -> " + (ok ? "ok" : "not found"));
      await sleep(parseInt(s.afterMs || 1200, 10));
    } else if (s.type === "set") {
      const ok = await setInputByLabel(page, s.label, s.value);
      console.log("STEP set " + s.label + " -> " + (ok ? "ok" : "not found"));
    } else if (s.type === "dump") {
      const d = await dumpPage(page);
      dumps.push(d);
      console.log("STEP dump -> url=" + d.url);
    }
  }
  return dumps;
}

async function main() {
  const [action, ...rest] = process.argv.slice(2);
  if (!PANEL || !PASSWORD) {
    throw new Error(
      "缺少敏感凭据：请先设置环境变量 SEALDICE_PANEL_URL 与 " +
        "SEALDICE_PANEL_PASSWORD（或 SEALDICE_PANEL_TOKEN）。PowerShell 示例：`$env:SEALDICE_PANEL_URL='http://host:port'; $env:SEALDICE_PANEL_PASSWORD='xxx'`"
    );
  }
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: EDGE,
      headless: true,
      args: ["--no-first-run", "--no-default-browser-check", "--disable-gpu"],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    if (action === "unlock") {
      await unlock(page);
      console.log("UNLOCK OK");
      return;
    }

    if (action === "logs") {
      const limit = parseInt(argValue(rest, "--limit", "30"), 10);
      await unlock(page);
      await sleep(2000);
      const data = await page.evaluate(async () => {
        const token = localStorage.getItem("t");
        const headers = token ? { authorization: token, token } : {};
        const r = await fetch("/sd-api/log/fetchAndClear", { headers });
        return r.ok ? { status: r.status, json: await r.json() } : { status: r.status, text: await r.text() };
      });
      if (data.status !== 200) throw new Error("log API status " + data.status);
      const entries = (data.json || []).slice(-limit);
      console.log("LOG_ENTRIES " + entries.length);
      for (const e of entries) {
        console.log(fmtTime(e.ts) + " [" + e.level + "] " + cleanMsg(e.msg));
      }
      return;
    }

    if (action === "open-js" || action === "plugins") {
      await unlock(page);
      await gotoJs(page);
      if (action === "open-js") {
        const info = await page.evaluate(() => ({
          url: location.href,
          tabs: [...document.querySelectorAll(".el-tabs__item, [role=tab]")].map((t) => t.textContent.trim()).filter(Boolean),
          buttons: [...document.querySelectorAll("button")].map((b) => b.textContent.trim()).filter(Boolean).slice(0, 60),
          hasFileInput: !!document.querySelector("input[type=file]"),
        }));
        console.log("JS_PAGE " + info.url);
        console.log("TABS " + JSON.stringify(info.tabs));
        console.log("BUTTONS " + JSON.stringify(info.buttons));
        console.log("HAS_FILE_INPUT " + info.hasFileInput);
        console.log("SAFETY: 未执行上传/重载/更新/删除");
      } else {
        const plugins = await page.evaluate(() => {
          const cards = [...document.querySelectorAll(".el-card.js-item")];
          return cards.map((card) => {
            const name = card.querySelector("b.el-text--large")?.textContent.trim() || "";
            const version =
              card.querySelector(".js-item-header .el-space__item:nth-child(3) .el-text")?.textContent.trim() || "";
            const enabled =
              !!card.querySelector(".el-switch.is-checked") ||
              card.querySelector("input.el-switch__input")?.checked === true;
            const buttons = [...card.querySelectorAll("button")]
              .map((b) => b.textContent.trim())
              .filter(Boolean);
            const details = {};
            card.querySelectorAll(".el-descriptions__cell").forEach((td) => {
              const label = td.querySelector(".el-descriptions__label")?.textContent.trim();
              const value = td.querySelector(".el-descriptions__content")?.textContent.trim();
              if (label && value) details[label] = value;
            });
            return { name, version, enabled, buttons, ...details };
          });
        });
        console.log("PLUGIN_COUNT " + plugins.length);
        for (const p of plugins) {
          const intro = (p["介绍"] || "").replace(/\s+/g, " ").slice(0, 60);
          console.log(
            [
              p.name,
              p.version,
              p.enabled ? "启用" : "停用",
              "安装:" + (p["安装时间"] || "?"),
              "更新:" + (p["更新时间"] || "?"),
              "作者:" + (p["作者"] || "?"),
              intro ? "介绍:" + intro + (p["介绍"].length > 60 ? "…" : "") : "",
            ]
              .filter(Boolean)
              .join(" | ")
          );
        }
        console.log("SAFETY: 未执行启用/停用/更新/删除");
      }
      return;
    }

    if (action === "screenshot") {
      const route = argValue(rest, "--route", "/mod/js");
      await unlock(page);
      await page.goto(PANEL + "/#" + route, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(3500);
      const file = OUT + "\\panel-" + route.replace(/[^a-z0-9]+/gi, "_") + ".png";
      await page.screenshot({ path: file });
      console.log("SCREENSHOT " + file);
      return;
    }

    if (action === "inspect") {
      await unlock(page);
      await gotoJs(page);
      console.log(JSON.stringify(await dumpPage(page), null, 2));
      return;
    }

    if (action === "click") {
      const text = rest[0];
      if (!text) throw new Error("click 需要文本参数");
      await unlock(page);
      await gotoJs(page);
      const ok = await clickText(page, text);
      await sleep(1500);
      console.log("CLICK " + text + " -> " + (ok ? "ok" : "not found"));
      return;
    }

    if (action === "set-input") {
      const label = rest[0];
      const value = rest[1];
      if (!label || value === undefined) throw new Error("set-input 需要 <标签> <值> 参数");
      await unlock(page);
      await gotoJs(page);
      const ok = await setInputByLabel(page, label, value);
      console.log("SET_INPUT " + label + " -> " + (ok ? "ok" : "not found"));
      return;
    }

    if (action === "steps") {
      const file = argValue(rest, "--file", null);
      if (!file) throw new Error("steps 需要 --file <steps.json>");
      const steps = JSON.parse(fs.readFileSync(file, "utf-8"));
      await unlock(page);
      await gotoJs(page);
      const dumps = await runSteps(page, steps);
      console.log("STEPS_DONE steps=" + steps.length + " dumps=" + dumps.length);
      for (const d of dumps) {
        console.log("DUMP " + JSON.stringify(d));
      }
      return;
    }

    if (action === "reload") {
      await unlock(page);
      await reloadJs(page);
      return;
    }

    if (action === "upload-reload") {
      const file = argValue(rest, "--file", DEFAULT_PLUGIN);
      await unlock(page);
      await uploadPlugin(page, file);
      await reloadJs(page);
      console.log("UPLOAD_RELOAD_OK " + file);
      return;
    }

    throw new Error("unknown action: " + action + " (expected unlock|logs|open-js|plugins|screenshot|inspect|click|set-input|steps|reload|upload-reload)");
  } finally {
    if (browser) await browser.close();
  }
}

main().catch((e) => {
  console.error("ERROR " + (e && e.message ? e.message : String(e)));
  process.exit(1);
});
