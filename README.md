# Fiddler Everywhere 8.x Patch

针对 Fiddler Everywhere **8.x** (Windows) 的授权补丁自动化工具。

**验证版本: 8.0.2** (Electron 39.8.6)。仅支持 8.x，不包含任何旧版本兼容代码。

> 用途声明：仅供已购授权用户进行保护机制研究与版本封堵验证。请支持正版。

## 快速使用

### 方式一: 直接下载成品

到 [Releases](../../releases) 下载已打包的 zip，解压后：

1. 任务管理器结束所有残留的 `Fiddler Everywhere` 进程
2. 右键**管理员**运行 `安装hosts.bat`（只需一次）
3. 运行 `Fiddler Everywhere.exe`，登录界面点 **Google 登录**

### 方式二: 自行构建

```bash
# 依赖: 7z, node, python3, curl
npm install -g @electron/asar
./build.sh                        # 自动下载 8.0.2 并构建
./build.sh 本地安装包.exe 8.0.2     # 使用本地安装包
# 产物: build/Fiddler-Everywhere-8.0.2-Patched.zip
```

## 工作原理

```
┌─────────────────────────────────────────────────────────┐
│  官方保护链 (8.0.2)                                      │
│                                                         │
│  Angular 前端                                            │
│   ├─ API 响应 ECDSA P-256 签名验证                       │
│   │   (时间戳参与签名输入, 静态签名立即过期)               │
│   ├─ qj2() 公钥白名单 (硬编码官方公钥)                    │
│   └─ URL 拆分字符串混淆                                  │
│                                                         │
│  .NET (FiddlerBackendSDK.dll)                           │
│   └─ 签名公钥白名单 (单字节标识比较)                      │
│                                                         │
│  原生 (policies.node)                                    │
│   └─ 客户端文件完整性校验                                 │
│       (GlobalSign EV 证书链 + TerminateProcess)          │
│                                                         │
│  Electron 主进程                                         │
│   └─ global.URL hook (还原伪服务器域名)                   │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  绕过方案                                                │
│                                                         │
│  1. 本地伪 API 服务器 (:5678)                            │
│     每次 API 响应实时 ECDSA 签名 (时间戳新鲜)             │
│  2. hosts: api/identity.getfiddler.be → 127.0.0.1        │
│  3. 主进程注入 (main.js 头部拼接 index.js)                │
│     ├─ 窗口加载期间临时改写 Angular URL → 还原            │
│     ├─ 渲染进程注入公钥白名单补丁                          │
│     ├─ SDK DLL 运行时字节补丁                             │
│     └─ global.URL 反 hook                                │
│  4. 抓包引擎: fiddler.dll → Yui-patch                    │
│                                                         │
│  原则: 客户端文件零永久修改                               │
│  (Angular/index.html 磁盘上始终与官方一致,                │
│   绕过 policies.node 完整性校验)                          │
└─────────────────────────────────────────────────────────┘
```

## 目录结构

```
├── build.sh                # 一键构建: 安装包 → 补丁成品 zip
├── server/
│   ├── index.js            # 主进程注入体 (hook + 伪API服务器)
│   └── file/               # 19 个 mock API 响应 (ECDSA 实时签名)
├── assets/
│   ├── hosts-install.bat   # hosts 安装 (自动提权)
│   ├── hosts-remove.bat    # hosts 卸载
│   └── 使用说明.txt
├── docs/
│   ├── ADAPTATION.md       # 版本更新适配指南
│   └── TECH_NOTES.md       # 技术笔记 (保护机制全景 + 迭代实录)
└── .github/workflows/      # CI 自动构建
```

## 常见问题

**Q: 为什么需要本地服务器，不能把响应写死在文件里？**
A: 每个 API 响应头带 ECDSA P-256 签名，`x-signature-timestamp` 毫秒时间戳参与签名输入，客户端校验时间新鲜度。静态文件的签名会立即过期，必须每次实时签名。

**Q: 卸载程序后为什么登录状态还在？**
A: 登录 token 存在 `%APPDATA%\Fiddler Everywhere`（per-user 数据），卸载不碰它。删除该文件夹即彻底重置。

**Q: 如何切换回官方版？**
A: 管理员运行 `卸载hosts.bat` → 删除 `%APPDATA%\Fiddler Everywhere` → 官方安装包重装。

**Q: 伪服务器会一直占用 5678 端口吗？**
A: 伪服务器随程序主进程启动/退出，不常驻。端口冲突时改 `server/index.js` 第一行的 `port`。

**Q: 程序双击没反应？**
A: ① 任务管理器结束残留进程 ② 确认 hosts 已安装 ③ 查看 `fe-patch.log` 定位卡点。

**Q: 版本更新后怎么办？**
A: 见 [docs/ADAPTATION.md](docs/ADAPTATION.md)。新版本未经验证，不保证可用。
