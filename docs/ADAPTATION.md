# 版本更新适配指南

> 仅在验证过的版本上使用（当前: 8.0.2）。新版本未经验证，不保证可用。

## 原则

**客户端文件零永久修改**。`policies.node` 启动时做文件完整性校验（GlobalSign EV 证书链 + 哈希），永久修改 Angular bundle / index.html = 进程被 TerminateProcess 静默击杀。所有绕过必须运行时完成。

## 适配流程

### 1. 重跑 build.sh

```bash
./build.sh "Fiddler Everywhere 8.0.3.exe" 8.0.3
```

构建脚本对以下变化自动适应：
- Angular hash 文件名（`main-XXXXXXX.js`）— index.js 从 index.html 正则提取
- asar 结构 — 提取为目录后不存在路径问题

### 2. 可能需要重新定位的点 (未验证, 仅作排查参考)

| 点 | 定位方法 |
|---|---|
| SDK DLL 公钥白名单字节 | 原字节 `16 2A 28 B1 04 00 0A`。若版本更新后找不到：用 `dnfile`/ILSpy 找 `FiddlerBackendSDK.dll` 中的公钥 token 比较，替换为新单字节使比较恒真。index.js 运行时也会兜底 patch |
| qj2 白名单结构 | 渲染进程注入的补丁匹配 P-256 SPKI DER 头 `30 59 30 13`（`48 89 48 19` 十进制），该值由 ECDSA P-256 曲线决定，稳定不变 |
| API 端点增删 | 运行后看主进程控制台 / fe-patch.log 的 `error: /xxx`（无 mock）日志，逐个在 `server/file/` 下补对应 JSON |
| policies.node 校验范围 | 若新版把 main.js 也纳入哈希校验，则需改用运行时内存补丁（harness 验证思路：先跑 pristine 基线确认环境正常，再逐项加补丁二分定位被杀点） |

### 3. 验证清单

```bash
# Angular bundle 必须与原版 MD5 一致 (运行时临时修改会自动还原)
md5sum build/*/resources/app/out/WebServer/ClientApp/dist/main-*.js
md5sum pristine对应文件

# index.html 一致
# package.json 的 main 字段原样 (out/main.js)
# fiddler.dll 是 Yui-patch 版
# SDK DLL 目标字节已替换
```

### 4. 实测

1. 任务管理器清残留进程
2. hosts 已安装（`ping api.getfiddler.be` 应 127.0.0.1）
3. 启动 → Google 登录 → 进入主界面 → 抓包/保存会话全流程
4. 失败时 `fe-patch.log` 分层定位：
   - 无 "v10 启动" 日志 → main.js 未执行（杀软拦截/文件缺失）
   - 有启动日志但立即结束 → 原生反篡改击杀（对照上表第 4 项）
   - 卡在某 CP 检查点 → 看检查点语义定位阶段
   - `error: /xxx` 无 mock → 补 mock 文件

## 诊断工具箱

- **fe-patch.log**：CP0-4 检查点（启动→锁→初始化→窗口）、500ms 心跳、模块加载、spawn、exit 调用链
- **Linux harness**（electron deep-stub）：可在无 Windows 环境下跑通 main.js 同步流程，用于区分 JS 层 / 原生层问题
- **基线对照法**：pristine 解包直接运行，隔离"补丁问题 vs 环境问题"
- **二分法**：逐项启用补丁（main.js → DLL → dll 替换 → hosts）定位被杀点

## 已知失败模式速查

| 现象 | 根因 |
|---|---|
| 双击无反应、无日志 | 杀软拦截 / 残留进程占锁 |
| 日志止于 policies 加载 | Angular/index.html 被永久修改（文件完整性校验击杀） |
| "Access to *.getfiddler.com is being blocked" | hosts 未安装或伪服务器未启动 |
| 登录界面报网络错误 | 5678 端口被占 / hosts 指向错误 |
| require fe-preload 找不到 | 把新文件 require 进了 asar 虚拟路径而未注入索引（本仓库布局不存在此问题） |
