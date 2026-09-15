---
title: 2026-07-28 弃用清单
tags: [mcp, deprecation]
updated: 2026-08-20
---

Roots、Sampling、Logging 三项被标记为弃用，弃用窗口至少十二个月。
建议迁移：目录改走工具参数或资源 URI，采样改直连模型厂商 API，
日志改写 stderr 或用 OpenTelemetry。
