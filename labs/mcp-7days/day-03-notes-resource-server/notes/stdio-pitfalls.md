---
title: stdio 传输的三个坑
tags: [mcp, transport]
updated: 2026-08-12
---

一、stdout 里不能出现任何非 MCP 消息，日志一律走 stderr。
二、消息内部不许有裸换行，一行一条。
三、stdin 读到 EOF 就应该尽快退出，这是唯一可移植的优雅停机信号。
