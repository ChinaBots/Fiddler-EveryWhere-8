# Mock 文件说明

`server/file/` 下的 JSON 是对**官方 API 端点响应的录制副本**（经代理抓包获得的服务器返回数据），不是代码：

- 目录/文件路径 = 客户端发起请求的 URL 路径（`<host>/<path>.json` 映射规则见 index.js 服务部分）
- 字段结构与取值由客户端硬编码的消费逻辑决定（例如 `everywhereMinVersionSupported`、配额对象、OAuth token 载荷），任何抓包复刻都会得到等价内容
- 运行时这些文件仅作为签名载荷被读入、规范化后交给签名引擎，配合每次实时生成的时间戳与密钥输出合规响应
- 未覆盖的端点在运行日志中以 `[endpoint-miss] <path>` 标记，按同规则补录即可

当前覆盖端点清单：

| 前缀 | 文件 |
|---|---|
| api.getfiddler.com | versions.json, users.json, users/sign-in.json, users/events/last-seen, composer-collections.json, events.json, push-notifications-configuration.json, quotas-usage.json(+1), rulesets.json, snapshots.json, trials/Everywhere/availability.json, c/**(latest.yml × 4, 更新通道) |
| identity.getfiddler.com | oauth/token.json, oauth/authorize, signout |
