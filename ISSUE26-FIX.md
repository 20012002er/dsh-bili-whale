Issue #26 最小修复，基于用户上传的 dsh-bili-whale-source-2026-10-23-c.zip。
修改 comment.mjs：分享请求加入配置主人昵称到 UID 的 at_name_to_mid 映射；UID 非正整数或超出安全整数范围时停止；仍只发布一条评论。
修改 package.json：纳入新增 mention.test.mjs；新增测试替身 helpers/mention-fetch.mjs。
与原包逐文件校验，原有文件只有上述 comment.mjs 和 package.json 变化，其余保持原包内容。
全部 98 项自动化测试通过。未发布真实评论，B 站通知送达效果未在线验证。未部署 DSH 或推送 GitHub。