---
title: ttlMs 与 cacheScope
tags: [mcp, caching]
updated: 2026-08-15
---

ttlMs 是新鲜度提示，单位毫秒。cacheScope 取 public 或 private，
决定共享中间层能不能缓存这一份响应。它和 listChanged 通知互补，不是二选一。
