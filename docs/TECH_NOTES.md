# 技术笔记

> 2026-08-26 交付记录。十版迭代实录 + 8.0.2 保护机制完整解剖。

## 保护机制全景 (8.0.2)

| 层 | 机制 | 绕过 |
|---|---|---|
| Angular 前端 | API 响应 ECDSA P-256 签名验证（时间戳参与签名输入，静态签名立即过期） | 本地伪服务器实时签名 |
| Angular 前端 | qj2() 公钥白名单（硬编码官方公钥） | 渲染进程注入 Array.prototype.some 补丁，匹配 P-256 SPKI DER 头 `30 59 30 13` |
| Angular 前端 | URL 拆分字符串混淆 `["https://","api",".get","fiddler",".com"]` | 窗口加载期间临时替换 → 加载完还原 |
| .NET (FiddlerBackendSDK.dll) | 签名公钥白名单（单字节标识） | 偏移 78957 `0x16→0x17` |
| 原生 (policies.node) | 文件完整性校验（GlobalSign EV 证书链 + FindFirstFileExW + TerminateProcess） | **不修改客户端文件**（运行时绕过） |
| Electron | global.URL constructor hook（把伪服务器 URL 还原为官方域名） | hook global.URL 反向处理 |

## policies.node（反篡改哨兵）

- 309KB Rust 原生模块，导入表含 `CreateFileW` / `FindFirstFileExW` / `GetModuleFileNameW` / `LoadLibrary+GetProcAddress`（动态加载 crypt32/wintrust）/ `TerminateProcess` / `IsDebuggerPresent`
- 字符串证据：GlobalSign EV 代码签名证书链（GlobalSign Root CA / CodeSigning CA / Telerik EED AD CS CA 2 / Progress Software EV）+ Microsoft 时间戳根证书
- 行为：启动时枚举/校验客户端文件 Authenticode 或哈希，不一致 → `TerminateProcess` **原生瞬杀**（无 JS 异常、无 exit 事件、无堆栈）
- 结论：客户端文件（尤其 Angular bundle、index.html）**磁盘状态必须与官方一致**

## 伪 API 服务器协议

```
请求: GET http://127.0.0.1:5678{原路径}
响应头:
  content-type: application/json; charset=utf-8
  x-signature-timestamp: <毫秒时间戳>
  x-date: <RFC 1123>
  Signature: SignedHeaders=content-type;x-date;x-signature-timestamp,
             Signature=<base64( len(pubKey) | pubKey DER | ECDSA-P256-SHA256 签名 )>
签名输入: "content-type:...\nx-date:...\nx-signature-timestamp:..." + body
```

公钥为每次启动新生成的 P-256 密钥对；白名单校验由渲染进程注入补丁放行。

## 十版失败根因链（摘要）

| 版本 | 架构 | 结果 | 根因 |
|---|---|---|---|
| v1 | 参考项目原样 + 永久 Angular patch 缺失 | **活**（但 Access blocked） | 架构正确，缺 hosts |
| v2-v4 | 永久 patch Angular 到磁盘 | 秒杀 | policies.node 文件校验 |
| v5-v6 | + 单实例锁/诊断 | 秒杀 | 同上（诊断日志证明死于 policies 加载） |
| v7 | loader + asar 注入 | require 崩溃 | 新文件不在 asar 索引 |
| v8 | 物理路径 require | 死于 policies | 物理路径形态改变触发防护 |
| v9 | asar 索引注入 | 死于 policies | Angular 仍是永久 patch 状态 |
| v10 | **完全复刻参考项目运行时架构 + hosts** | **可用** | — |

**破案关键**：唯一存活的 v1 = 唯一没有永久修改 Angular 的版本。对比 v1/v2 磁盘差异即锁定根因。

## 诊断方法论

1. **分层日志**：CP 检查点（锁→初始化→原生模块→窗口）+ 500ms 心跳（区分"挂死"与"瞬死"）+ Module._load + spawn + exit 调用链
2. **Linux harness**：electron deep-stub（Proxy 递归伪造），容器内跑通 main.js 同步流程，排除 JS 层嫌疑
3. **基线对照**：pristine 解包直接运行，先分清"补丁问题 vs 环境问题"
4. **二分定位**：逐项启用补丁，找到被杀的最小组合

## hosts 说明

```
127.0.0.1 api.getfiddler.be
127.0.0.1 identity.getfiddler.be
```

- 用 `.be` 而非 `.com`：参考项目约定，mock 文件路径与 server/file/ 目录结构对应
- hosts 是**必须的**：没有它，Angular 请求官方域名，伪服务器收不到流量
- 卸载：管理员 PowerShell 直接运行（不要嵌套 `powershell -Command`，外层会吞 `$_`）：
  ```powershell
  (Get-Content C:\Windows\System32\drivers\etc\hosts) | Where-Object {$_ -notmatch 'getfiddler'} | Set-Content C:\Windows\System32\drivers\etc\hosts
  ```

## 登录状态

- 伪 OAuth token 持久化于 `%APPDATA%\Fiddler Everywhere`
- 卸载程序不清除该目录（per-user 数据）
- 切换官方版：卸 hosts → 删该目录 → 重装官方版
