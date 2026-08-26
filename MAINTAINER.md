[Tools.md 使用指引]

本仓库 CI 产物(zip)为完整可直接运行的补丁版工具包。

维护者注意事项:
1. workflow 触发方式: Actions → Build & Auto Release → Run workflow (可输入版本号)
   或推送 v* 格式的 tag (tag 名决定发布版本号)
2. Release 自动创建, tag 冲突时自动追加 -r<run_number> 后缀
3. 版本兼容性验证流程见 docs/ADAPTATION.md
4. mock 端点缺失时看构建日志的 endpoint-miss 标记
