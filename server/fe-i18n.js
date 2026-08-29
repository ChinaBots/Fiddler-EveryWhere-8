/*!
 * fe-i18n.js — Fiddler Everywhere 汉化 / AI 自定义端点模块 (独立实现)
 * 机制:
 *  1. 语言包: resources/app/lang/*.json (key=英文原文, value=译文) — 放入即生效
 *  2. 内存替换: protocol.interceptFileProtocol 拦截 file://, 对 UI bundle 做内存级
 *     字符串替换后经临时文件返回; 安装目录磁盘文件零修改 (不触碰 policies 校验)
 *  3. 语言切换: did-finish-load 注入悬浮按钮, 通过 location.search 携带
 *     ?fe-i18n=<lang> 通知主进程 (无需 IPC/无需 CORS), 主进程持久化后由
 *     拦截层按新语言返回 bundle, 前端自动重载生效
 *  4. AI 自定义端点: lang/ai-endpoint.json 存在时:
 *     - process.env.OPENAI_BASE_URL / ANTHROPIC_BASE_URL 指向自定义端点
 *       (Fiddler 构造 ChatOpenAI/ChatAnthropic 未传 baseURL, SDK 默认吃环境变量)
 *     - models 覆盖: 将 bundle 内 openAIModels/anthropicModels 数组替换为
 *       配置中的自定义模型清单, 使设置页下拉出现自定义模型
 */
(function () {
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { app, protocol, ipcMain, webContents } = require('electron');

const LANG_DIR = path.resolve(__dirname, '../lang');
const DIST_DIR = path.resolve(__dirname, './WebServer/ClientApp/dist');
const MARK_FILE = path.join(LANG_DIR, '.current');
const AI_CFG_FILE = path.join(LANG_DIR, 'ai-endpoint.json');

const log = (() => {
  try {
    const p = path.join(path.dirname(process.execPath), 'fe-i18n.log');
    return m => { try { fs.appendFileSync(p, `[${new Date().toISOString()}] [i18n] ${m}\n`); } catch (_) {} };
  } catch (_) { return () => {}; }
})();

/* ---------------- 语言包管理 ---------------- */

function listLangPacks() {
  try {
    return fs.readdirSync(LANG_DIR)
      .filter(f => f.endsWith('.json') && !f.startsWith('.') && f !== 'ai-endpoint.json')
      .map(f => path.basename(f, '.json'));
  } catch (_) { return []; }
}

function currentLang() {
  try {
    const l = fs.readFileSync(MARK_FILE, 'utf-8').trim();
    if (l && listLangPacks().includes(l)) return l;
  } catch (_) {}
  return '';
}

function setCurrentLang(lang) {
  try {
    fs.mkdirSync(LANG_DIR, { recursive: true });
    fs.writeFileSync(MARK_FILE, lang, 'utf-8');
    log(`language set to "${lang}"`);
  } catch (e) { log(`set lang failed: ${e.message}`); }
}

function loadDict(lang) {
  if (!lang) return {};
  try {
    const raw = fs.readFileSync(path.join(LANG_DIR, lang + '.json'), 'utf-8');
    const obj = JSON.parse(raw);
    // 仅接受 string->string 条目; 忽略以 ! 开头的注释键
    const dict = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('!')) continue;
      if (typeof k === 'string' && typeof v === 'string' && k.length && v.length) dict[k] = v;
    }
    return dict;
  } catch (e) { log(`load ${lang} failed: ${e.message}`); return {}; }
}

/* ---------------- 替换引擎 ---------------- */

// 标识符类词(协议值/枚举)保护名单 — 这些串即使命中也绝不替换
const DENYLIST = new Set([
  'openai', 'anthropic', 'azure_openai', 'google_gemini', 'Azure', 'OpenAI', 'Anthropic',
  'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'CONNECT',
  'GET, POST', 'utf-8', 'gzip', 'br', 'deflate', 'HTTP/1.1', 'HTTP/2',
  'Bearer', 'Basic', 'Cookie', 'Set-Cookie', 'Authorization', 'Content-Type',
  'application/json', 'application/xml', 'text/html', 'multipart/form-data',
  'chrome', 'favicon', 'index.html', 'main.js', 'localhost', '127.0.0.1',
]);

// 词条准入: 降低误伤(协议值/标识符/类名)概率
function admissible(key) {
  if (key.length < 2 || key.length > 120) return false;
  if (DENYLIST.has(key)) return false;
  if (/^[\s\d.,:;!?()\[\]{}"'`~@#$%^&*+=|\\/<>_-]+$/.test(key)) return false; // 纯符号
  if (/^(?:[a-z0-9_]+-)+[a-z0-9_]+$/.test(key)) return false;                 // css/kebab-id
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) && /^[a-z]/.test(key)) return false; // camel/snake 标识符
  if (/^(?:app|ng|mat|kendo|x-|data-)[\s-]/i.test(key)) return false;
  // UI 文案特征: 含空格的短语 / 首字母大写词 / 全大写词 / 含中英混排符号
  return /\s/.test(key) || /^[A-Z]/.test(key) || key.length >= 4;
}

function buildReplacer(dict) {
  // 长键优先, 防止短键吞噬长短语
  const keys = Object.keys(dict).filter(admissible).sort((a, b) => b.length - a.length);
  let count = 0;
  return function apply(src) {
    count = 0;
    for (const k of keys) {
      const v = dict[k];
      const needle = '"' + k + '"';
      if (src.indexOf(needle) === -1) continue;
      const parts = src.split(needle);
      count += parts.length - 1;
      src = parts.join('"' + v + '"');
    }
    return { src, count };
  };
}

/* ---------------- 模型清单覆盖 ---------------- */

function loadAiConfig() {
  try { return JSON.parse(fs.readFileSync(AI_CFG_FILE, 'utf-8')); }
  catch (_) { return null; }
}

function applyModelOverride(src, cfg, stat) {
  if (!cfg || !Array.isArray(cfg.models)) return src;
  const pick = p => cfg.models.filter(m => typeof m === 'string' && m.trim()).map(m => m.trim());
  const openai = cfg.provider === 'anthropic' ? null : pick();
  const anthropic = cfg.provider === 'anthropic' ? pick() : null;
  try {
    if (openai && openai.length) {
      src = src.replace(/openAIModels=\[[^\]]*\]/, `openAIModels=${JSON.stringify(openai)}`);
      stat.modelsOpenAI = openai.length;
    }
    if (anthropic && anthropic.length) {
      src = src.replace(/anthropicModels=\[[^\]]*\]/, `anthropicModels=${JSON.stringify(anthropic)}`);
      stat.modelsAnthropic = anthropic.length;
    }
  } catch (e) { log(`model override failed: ${e.message}`); }
  return src;
}

/* ---------------- 环境变量注入 (AI 自定义端点) ---------------- */

function injectAiEnv() {
  const cfg = loadAiConfig();
  if (!cfg || !cfg.enabled || !cfg.baseUrl) return;
  const base = String(cfg.baseUrl).replace(/\/+$/, '');
  if (cfg.provider === 'anthropic') {
    process.env.ANTHROPIC_BASE_URL = base;
    if (cfg.apiKey) process.env.ANTHROPIC_API_KEY = String(cfg.apiKey);
    if (cfg.authToken) process.env.ANTHROPIC_AUTH_TOKEN = String(cfg.authToken);
    log(`AI endpoint(anthropic) -> ${base}`);
  } else {
    process.env.OPENAI_BASE_URL = base;
    if (cfg.apiKey) process.env.OPENAI_API_KEY = String(cfg.apiKey);
    log(`AI endpoint(openai) -> ${base}`);
  }
  // 透传附加 env (可选, e.g. OPENAI_API_VERSION)
  if (cfg.extraEnv && typeof cfg.extraEnv === 'object') {
    for (const [k, v] of Object.entries(cfg.extraEnv)) process.env[k] = String(v);
  }
}

/* ---------------- 临时文件缓存 ---------------- */

const TMP_DIR = path.join(os.tmpdir(), 'fe-i18n-cache');
function tmpPathFor(origPath, tag) {
  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const safe = origPath.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
    return path.join(TMP_DIR, `${tag}-${safe}`);
  } catch (_) { return origPath; }
}

/* ---------------- file:// 协议拦截 ---------------- */

function installFileInterceptor() {
  // 逃生开关: 存在 lang/disabled 文件则不装拦截器 (回到官方 file:// 行为)
  try {
    if (fs.existsSync(path.join(LANG_DIR, 'disabled'))) {
      log('escape hatch active (lang/disabled), interceptor NOT installed');
      return;
    }
  } catch (_) {}
  const lang = currentLang();
  const aiCfg0 = loadAiConfig();
  // 缓存标签: 语言或 AI 配置变化后强制重建临时文件
  const tag = `${lang || 'raw'}-${aiCfg0 && Array.isArray(aiCfg0.models) ? aiCfg0.models.length : 0}`;
  let served = 0;
  log(`interceptor installed, lang="${lang || '(raw)'}"`);

  // 关键: 用 fileURLToPath 解析 file:// URL (正确处理 Windows 盘符/空格%20),
  // new URL().pathname 在 Windows 会给出 "/C:/xxx%20yyy" 这种坏路径 — 曾导致全 UI 加载失败
  const { fileURLToPath } = require('url');
  const toPath = (u) => {
    const clean = String(u || '').split('?')[0].split('#')[0];
    let p = fileURLToPath(clean); // throws on malformed
    // 跨平台防御: 异常形态 "/C:/..." → "C:/..." (Windows 盘符)
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
    return p;
  };

  protocol.interceptFileProtocol('file', (request, callback) => {
    try {
      let filePath = '';
      try { filePath = toPath(request.url); }
      catch (e) { log(`url->path failed: ${String(request.url).slice(0, 80)} : ${e.message}`); }

      // 切换语言信号: index.html?fe-i18n=xx (query 已在 toPath 前剥离)
      const m = /[?&]fe-i18n=([A-Za-z0-9_-]+)/.exec(request.url || '');
      if (m && m[1]) {
        const want = m[1] === 'en' ? '' : m[1];
        if (want !== currentLang()) setCurrentLang(want);
        global.__feI18nRebuild && global.__feI18nRebuild();
      }

      if (!filePath) return callback('');

      const isDist = filePath.startsWith(DIST_DIR);
      const base = path.basename(filePath);
      const isBundle = /^main-.*\.js$/.test(base) || base === 'index.html';

      if (!isDist || !isBundle || !global.__feI18nApply) {
        // 透传: fileURLToPath 的结果即干净本地路径, 直接交回
        return callback(filePath);
      }

      // 内存替换管线
      const stat = {};
      let src = fs.readFileSync(filePath, 'utf-8');
      const r = global.__feI18nApply(src);
      src = r.src;
      stat.replacements = r.count;
      src = applyModelOverride(src, global.__feI18nAiCfg, stat);
      const out = tmpPathFor(filePath, tag);
      fs.writeFileSync(out, src, 'utf-8');
      served++;
      log(`served ${base} via memory-rewrite (${stat.replacements} repl, models o=${stat.modelsOpenAI || 0}/a=${stat.modelsAnthropic || 0}), served=${served}`);
      return callback(out);
    } catch (e) {
      log(`interceptor error: ${e.message}`);
      try {
        // 兜底: 尽力还原出原路径, 保证请求不被拦截层杀死
        const fallback = (() => {
          try { return toPath(String(request.url || '').split('?')[0].split('#')[0]); }
          catch (_) { return ''; }
        })();
        return callback(fallback);
      } catch (_) { /* 放弃, 交由 Electron 默认失败处理 */ }
    }
  });
}

/* ---------------- 语言切换按钮注入 ---------------- */

const SWITCHER_JS = `
(function(){
  if (window.__feI18nSwitcher) return;
  window.__feI18nSwitcher = true;
  var LANGS = window.__FE_I18N_LANGS || [];
  var CUR = window.__FE_I18N_CURRENT || '';
  var box = document.createElement('div');
  box.id = 'fe-i18n-switcher';
  var ACC = '#e6001a', W = 'translateZ(0)';
  box.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:2147483647;display:flex;flex-direction:column;align-items:flex-end;gap:4px;font-family:Segoe UI,system-ui,sans-serif;' + W;
  var btn = document.createElement('div');
  btn.textContent = CUR ? (CUR === 'zh-CN' ? '中' : CUR.toUpperCase().slice(0,2)) : 'EN';
  btn.title = '语言 / Language';
  btn.style.cssText = 'width:30px;height:30px;border-radius:50%;background:'+ACC+';color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 1px 6px rgba(0,0,0,.35);user-select:none;opacity:.55;transition:opacity .15s;';
  btn.onmouseenter = function(){ btn.style.opacity = '1'; };
  btn.onmouseleave = function(){ btn.style.opacity = '.55'; };
  var menu = document.createElement('div');
  menu.style.cssText = 'display:none;flex-direction:column;background:#fff;border:1px solid #ddd;border-radius:8px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.18);';
  function item(label, val, active){
    var d = document.createElement('div');
    d.textContent = label;
    d.style.cssText = 'padding:6px 14px;font-size:12px;cursor:pointer;white-space:nowrap;' + (active ? 'background:#fdeaea;color:'+ACC+';font-weight:600;' : 'color:#333;');
    d.onmouseenter = function(){ d.style.background = active ? '#fbd9d9' : '#f5f5f5'; };
    d.onmouseleave = function(){ d.style.background = active ? '#fdeaea' : ''; };
    d.onclick = function(ev){ ev.stopPropagation(); if (val === CUR) { menu.style.display='none'; return; }
      var u = new URL(location.href); u.searchParams.set('fe-i18n', val || 'en');
      location.href = u.href; };
    return d;
  }
  menu.appendChild(item('English (原版)', '', CUR === ''));
  LANGS.forEach(function(l){ menu.appendChild(item(l, l, l === CUR)); });
  btn.onclick = function(ev){ ev.stopPropagation(); menu.style.display = menu.style.display === 'none' ? 'flex' : 'none'; };
  document.addEventListener('click', function(){ menu.style.display = 'none'; });
  box.appendChild(menu); box.appendChild(btn);
  function mount(){ var root = document.body || document.documentElement; if (root && !root.contains(box)) root.appendChild(box); }
  mount();
  new MutationObserver(mount).observe(document.documentElement, {childList:true, subtree:true});
})();
`;

function attachSwitcher() {
  app.on('web-contents-created', (_, wc) => {
    if (wc.getType() !== 'window') return;
    wc.on('did-finish-load', () => {
      try {
        const langs = listLangPacks();
        wc.executeJavaScript(
          `window.__FE_I18N_LANGS=${JSON.stringify(langs)};window.__FE_I18N_CURRENT=${JSON.stringify(currentLang())};` + SWITCHER_JS,
          true
        ).catch(() => {});
      } catch (_) {}
    });
  });
}

/* ---------------- 启动 ---------------- */

function init() {
  try { fs.mkdirSync(LANG_DIR, { recursive: true }); } catch (_) {}
  injectAiEnv();

  // 替换器热重建 (切换语言时调用); buildReplacer 返回 apply(src)->{src,count}
  global.__feI18nRebuild = () => {
    const lang = currentLang();
    const apply = buildReplacer(loadDict(lang));
    global.__feI18nApply = apply;
    global.__feI18nAiCfg = loadAiConfig();
    log(`rebuilt replacer lang="${lang || '(raw)'}" entries=${Object.keys(loadDict(lang)).length}`);
  };

  {
    const lang = currentLang();
    global.__feI18nApply = buildReplacer(loadDict(lang));
    global.__feI18nAiCfg = loadAiConfig();
    log(`i18n ready: lang="${lang || '(raw)'}" entries=${Object.keys(loadDict(lang)).length} aiCfg=${global.__feI18nAiCfg && global.__feI18nAiCfg.enabled ? 'on' : 'off'}`);
  }

  app.whenReady().then(() => {
    try {
      installFileInterceptor();
      attachSwitcher();
      log('protocol interceptor + switcher installed');
    } catch (e) { log(`install failed: ${e.message}`); }
  });

  // 允许外部在开发时清理缓存
  ipcMain && ipcMain.on && ipcMain.on('fe-i18n:cleanup', () => {
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
  });
}

init();
})();
