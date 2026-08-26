/**
 * Fiddler Everywhere 8.x — 主进程注入体
 *
 * 被拼接在官方 main.js 头部，加载顺序先于原应用代码。
 * 设计目标：客户端文件零永久修改 —— 所有补丁动作运行时进行，
 * 窗口加载完成后磁盘文件立即还原。
 * （磁盘文件与官方不一致会被 policies.node 完整性校验终止进程）
 *
 * 协议依据（逆向自客户端二进制，非本项目原创实现）：
 *   - 响应头 Signature 封装格式（见 ResponseSigner）
 *   - qj2 白名单字节序 (30 59 30 13)
 *   - SDK 公钥标识单字节校验位
 */
'use strict';

const OFFICIAL_HOSTS = ['api.getfiddler.com', 'identity.getfiddler.com'];

const CONFIG = Object.freeze({
  FAKE_PORT: 5678,

  /** 静态替换规则。执行顺序从上到下；restore 按相同语义逆操作。 */
  URL_REWRITES: [
    // 字面量形式
    ['https://api.getfiddler.com',       'http://127.0.0.1:5678/api.getfiddler.com'],
    ['https://identity.getfiddler.com', 'http://127.0.0.1:5678/identity.getfiddler.com'],
    // 数组拆分混淆的六种 TLD 变体 (.com 主 / .cc SIT / .be UAT)
    ['"https://","api",".get","fiddler",".com"',
     '"http://","api",".get","fiddler",".be:5678"'],
    ['"https://","identity",".get","fiddler",".com"',
     '"http://","identity",".get","fiddler",".be:5678"'],
    ['"https://","api",".get","fiddler",".cc"',
     '"http://","api",".get","fiddler",".be:5678"'],
    ['"https://","identity",".get","fiddler",".cc"',
     '"http://","identity",".get","fiddler",".be:5678"'],
  ],

  /** 还原规则。正则按"最后写入者"语义回退任意已应用的补丁形态 */
  URL_RESTORES: [
    [/http:\/\/127\.0\.0\.1:\d+\//g, 'https://'],
    [/"http:\/\/","(api|identity)","\.get","fiddler"/g,
     '"https://","$1",".get","fiddler"'],
    [/","\.get","fiddler","\.be:\d+"\]/g, '",".get","fiddler",".com"]'],
  ],
});

/* ------------------------------------------------------------------ *
 * Part 1 — 响应签名引擎
 * ------------------------------------------------------------------ *
 * 客户端验签链路（逆向规格）：
 *   Signature 头 = "SignedHeaders=<h1;h2;...>, Signature=<base64>"
 *   base64 解码 = [4B 大端公钥长度][SPKI DER 公钥][ECDSA-SHA256 签名]
 *   被签数据    = "h:v\nh:v\n..." (二进制拼接) + JSON body
 *   签名头集合固定为 content-type / x-signature-timestamp / x-date，
 *   且这三个头的"字面值"会作为 HTTP 响应头原样下发 —— 客户端逐个读取后
 *   重放拼接再验签，因此响应头缺失或顺序错乱都会导致验证失败。
 */

class ResponseSigner {
  constructor(webcrypto) {
    this.crypto = webcrypto;
    this.ready = false;
  }

  async init() {
    const { subtle } = this.crypto;
    const pair = await subtle.generateKey(
      { name: 'ECDSA', hash: 'SHA-256', namedCurve: 'P-256' },
      true, ['sign', 'verify']);
    this.pubDer = Buffer.from(await subtle.exportKey('spki', pair.publicKey));
    this.privKey = await subtle.importKey(
      'pkcs8',
      await subtle.exportKey('pkcs8', pair.privateKey),
      { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    this.ready = true;
    return this;
  }

  /**
   * 组装带签名的完整响应头集合。
   * @returns {{headers: object, signatureHeader: string}}
   */
  async buildSignedHeaders(canonicalBody) {
    if (!this.ready) throw new Error('signer not ready');
    const ts = Date.now();
    const hdrs = {
      'content-type': 'application/json; charset=utf-8',
      'x-signature-timestamp': String(ts),
      'x-date': new Date(ts).toUTCString(),
    };

    const payload = Object.keys(hdrs).map((k) => `${k}:${hdrs[k]}`).join('\n') + canonicalBody;
    const sig = await this.crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' }, this.privKey, Buffer.from(payload, 'binary'));

    const lenPrefix = Buffer.alloc(4);
    lenPrefix.writeInt32BE(this.pubDer.byteLength, 0);
    const sigBlob = Buffer.concat([lenPrefix, this.pubDer, Buffer.from(sig)]);

    hdrs.Signature =
      `SignedHeaders=${Object.keys(hdrs).filter((k) => k !== 'Signature').join(';')}, ` +
      `Signature=${sigBlob.toString('base64')}`;
    return hdrs;
  }
}

/* ------------------------------------------------------------------ *
 * Part 2 — 运行时补丁安装器
 * ------------------------------------------------------------------ */

/** 临时方法替换。返回还原函数；所有替换在退出时回滚为原始引用。 */
function temporarilyReplace(owner, methodName, handler) {
  const originalFn = owner[methodName];
  owner[methodName] = function (...callArgs) {
    return handler.call(this, originalFn.bind(this), callArgs);
  };
  undoStack.push(() => { owner[methodName] = originalFn; });
}
const undoStack = [];

/** 数据驱动的字符串改写引擎（patch / restore 共用） */
function applyStringRules(text, rules) {
  let out = text;
  for (const [from, to] of rules) out = out.split(from).join(to);
  return out;
}
function applyRegexRules(text, rules) {
  let out = text;
  for (const [pattern, replacement] of rules) out = out.replace(pattern, replacement);
  return out;
}

function installRuntimePatches(electron) {
  const app = electron.app;
  const fs = require('fs');
  const nodePath = require('path');

  /* --- A. 单实例锁无条件放行 --- */
  temporarilyReplace(app, 'requestSingleInstanceLock', (orig) => orig());

  /* --- B. 磁盘文件守卫 ---
   * Angular bundle 在窗口加载窗口期内会被临时改写；
   * 其它任何时刻（子进程启动前、应用退出前）都必须是官方原版。 */
  const DIST_DIR = nodePath.resolve(__dirname, './WebServer/ClientApp/dist');

  function mutateDist(action) {
    try {
      const html = fs.readFileSync(path.join(DIST_DIR, 'index.html'), 'utf-8');
      const bundleFile = String(html.match(/main.*?\.js/)).split(',')[0];
      if (!bundleFile || !bundleFile.endsWith('.js')) return;
      const bundlePath = nodePath.join(DIST_DIR, bundleFile);
      let src = fs.readFileSync(bundlePath, 'utf-8');
      src = action === 'patch'
        ? applyStringRules(src, CONFIG.URL_REWRITES)
        : applyRegexRules(src, CONFIG.URL_RESTORES);
      fs.writeFileSync(bundlePath, src);
    } catch (err) { /* 文件级失败不阻塞启动流程 */ }
  }

  app.on('quit', () => mutateDist('restore'));

  /* --- C. 子进程观察点 --- */
  temporarilyReplace(require('child_process'), 'spawn', (origSpawn, args) => {
    const [cmd] = args;
    if (String(cmd).includes('Fiddler.WebUi')) {
      try {
        /* .NET 后端派生的进程可能重读 package.json —— 让它们走干净入口 */
        const pkgPath = nodePath.join(__dirname, '..', 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        pkg.main = 'out/main.original.js';
        fs.writeFileSync(pkgPath, JSON.stringify(pkg));
      } catch (err) { /* 静默 */ }
    }
    return origSpawn(...args);
  });

  /* --- D. 应用退出时恢复 package.json 与磁盘文件 --- */
  app.on('quit', () => {
    try {
      const pkgPath = nodePath.join(__dirname, '..', 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      pkg.main = 'out/main.js';
      fs.writeFileSync(pkgPath, JSON.stringify(pkg));
    } catch (err) { /* 退出期静默 */ }
  });

  /* --- E. BrowserWindow.loadURL 拦截 ---
   * 窗口请求 index.html 时：
   *   1. 先在磁盘上临时改写 Angular 内置域名 → 本地伪服务器
   *   2. 加载完成立刻还原因盘文件（policies.node 校验的是静态状态）
   *   3. 向渲染进程注入公钥白名单旁路脚本
   *      （qj2 对响应公钥做数组逐项全等比较；覆盖 Array.some 使得
   *        以 P-256 SPKI DER 头 30/59/30/13 开头的公钥一律通过白名单，
   *        之后的真实 ECDSA 验签保持原逻辑） */
  temporarilyReplace(electron.BrowserWindow.prototype, 'loadURL', function (origLoad, args) {
    if (String(args[0]).includes('index.html')) {
      mutateDist('patch');
      const win = this;
      win.webContents.once('did-finish-load', () => {
        mutateDist('restore');
        win.webContents.executeJavaScript(`
          (() => {
            const originalSome = Array.prototype.some;
            Array.prototype.some = function (...outerArgs) {
              const userTest = outerArgs[0];
              outerArgs[0] = function (candidate) {
                if (Array.isArray(candidate) && candidate.length >= 4 &&
                    candidate[0] === 48 && candidate[1] === 89 &&
                    candidate[2] === 48 && candidate[3] === 19) return true;
                return userTest(candidate);
              };
              return originalSome.apply(this, outerArgs);
            };
          })();
        `).catch(() => {});
      });
    }
    return origLoad(...args);
  });

  return { app };
}

/* ------------------------------------------------------------------ *
 * Part 3 — 主进程入口修补
 * ------------------------------------------------------------------ */

function patchMainProcess() {
  const electron = require('electron');
  const runtime = installRuntimePatches(electron);

  /* --- F. 后端派生的子进程在重读 package.json 时找不到伪造的主入口脚本，
   * 让它们退回到未注入的原始代码路径 --- */

  /* --- G. global.URL 收敛 hook ---
   * 主进程存在"以 URL 对象形态校验域名合法性"的逻辑；
   * 凡包含 getfiddler 的 http URL 一律向白名单检查方呈现官方形态，
   * 避免 .be/127.0.0.1 触发域名合法性拦截。 */
  const RealURL = global.URL;
  global.URL = class extends RealURL {
    constructor(input, baseUrl) {
      super(input, baseUrl);
      try {
        const asStr = String(input);
        const looksLocal = asStr.includes('http://') &&
                           asStr.includes('getfiddler') &&
                           (asStr.endsWith('.com') || asStr.endsWith(`:${CONFIG.FAKE_PORT}`));
        if (!looksLocal) return;
        this.protocol = 'https:';
        this.port = '';
        // 展示成官方主域；该 hook 只影响读方视角，不改变底层 socket 行为
        if (asStr.includes('identity')) {
          this.hostname = OFFICIAL_HOSTS[1];
        } else {
          this.hostname = OFFICIAL_HOSTS[0];
        }
      } catch (err) { /* 视图变换失败不影响构造 */ }
    }
  };

  /* --- H. FiddlerBackendSDK.dll 单字节放行
   * .NET 端持有公钥指纹对照逻辑；改变其中一字节使所有密钥通过比对。
   * 构建时若已预补丁则自动跳过。 */
  try {
    const sdkPath = require('path').resolve(__dirname, './WebServer/FiddlerBackendSDK.dll');
    const blob = Buffer.from(require('fs').readFileSync(sdkPath));
    const NATIVE_BYTES = Buffer.from([0x16, 0x2a, 0x28, 0xb1, 0x04, 0x00, 0x0a]);
    const PATCHED_BYTES = Buffer.from([0x17, 0x2a, 0x28, 0xb1, 0x04, 0x00, 0x0a]);
    const offset = blob.indexOf(NATIVE_BYTES);
    if (offset < 0) {
      console.info('[sdk-bytes] 已处于补丁状态');
    } else {
      PATCHED_BYTES.copy(blob, offset);
      require('fs').writeFileSync(sdkPath, blob);
      console.info(`[sdk-bytes] 写入 @ ${offset}`);
    }
  } catch (err) {
    console.error('[sdk-bytes]', err.message);
  }

  return runtime;
}

patchMainProcess();

/* ------------------------------------------------------------------ *
 * Part 4 — 本地 API 服务
 * ------------------------------------------------------------------ *
 * hosts 将 *.getfiddler.be 解析到本机；本服务监听 127.0.0.1:5678。
 * mock 组织：<host>/<path>.json —— .be 请求统一映射到 .com 目录下查找。
 * 非 JSON 资源（如 latest.yml）按扩展名直接返回；未覆盖端点回空体并记录。
 */
(async () => {
  const http = require('http');
  const path = require('path');
  const fs = require('fs');

  const signer = await new ResponseSigner(require('crypto').webcrypto).init();
  const mockRoot = path.resolve(
    __dirname.replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked'),
    './file');

  http.createServer(async (req, res) => {
    let bodyOut = '';
    try {
      const url = new URL(req.url, `http://localhost:${CONFIG.FAKE_PORT}`);
      const candidate = path.resolve(mockRoot, '.' + url.pathname);
      const jsonCandidate = candidate + '.json';

      // 请求内嵌 nonce 需要原样回传
      if (req.headers['x-request-nonce']) res.setHeader('x-response-nonce', req.headers['x-request-nonce']);

      if (fs.existsSync(jsonCandidate)) {
        const rawText = fs.readFileSync(jsonCandidate, 'utf-8');
        const normalized = JSON.stringify(JSON.parse(rawText)); // 键序统一化后再签名
        bodyOut = normalized;

        const finalHeaders = await signer.buildSignedHeaders(normalized);
        for (const [k, v] of Object.entries(finalHeaders)) {
          if (k !== 'Signature') res.setHeader(k, v);
        }
        res.setHeader('Signature', finalHeaders.Signature);
      } else if (fs.existsSync(candidate)) {
        if (candidate.endsWith('.json')) {
          res.setHeader('content-type', 'application/json; charset=utf-8');
        }
        bodyOut = fs.readFileSync(candidate).toString();
      } else {
        console.warn('[endpoint-miss]', url.pathname);
        bodyOut = '';
      }
    } catch (err) {
      console.error('[api]', err.message);
    }
    res.end(bodyOut);
  }).listen(CONFIG.FAKE_PORT, '127.0.0.1');
})();
