== Fiddler Everywhere 8.0.2 汉化 / AI 自定义端点 ==

一、汉化 (即放即用)
  把语言包 JSON (如 zh-CN.json) 放进本目录即可生效:
    resources/app/lang/zh-CN.json
  - 启动后 UI 右上角有悬浮切换按钮 (中/EN), 点击即时切换, 无需重启。
  - 删除 .current 文件或选择 "English" 即回到英文原版。
  - 想自己改词条: 直接编辑 JSON, key=英文原文, value=译文, 保存后点切换按钮刷新。
  - 语言包文件名即语言名 (如 zh-TW.json = 繁体, ja.json = 日文), 放进来就会出现在切换菜单里。
  - 安装目录的磁盘文件不会被修改 (全部在内存中替换), 不触发反篡改校验。

二、AI 自定义端点
  1. 复制 ai-endpoint.json.example 为 ai-endpoint.json
  2. 修改 baseUrl / apiKey / provider / models
  3. 重启 Fiddler
  原理: Fiddler AI 内置的 OpenAI / Anthropic SDK 未显式指定 baseURL,
  尊重 OPENAI_BASE_URL / ANTHROPIC_BASE_URL 环境变量; 本模块启动时注入,
  使 AI 请求直达你自己的 OpenAI 兼容端点 (one-api / new-api / 自建网关均可)。
  models 数组会覆盖设置页的模型下拉清单, 用于自定义模型名。
  对照: provider 也可以选 "Azure OpenAI" 并在应用设置里填 URI (原生支持,
  但要求 Azure 协议格式 /openai/deployments/{name}/...; 通用兼容网关建议用本方案)。

三、日志
  主程序目录下 fe-i18n.log — 记录每次 bundle 替换的词条命中数, 便于排查。

风险提示: 字符串替换为全文匹配 (带引号), 个别词条若恰好是后端协议字段值,
理论上可能影响相关功能; 遇到异常可删除对应词条或整包切回英文排查。
