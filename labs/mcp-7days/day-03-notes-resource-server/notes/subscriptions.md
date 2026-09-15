---
title: 两条通知通道
tags: [mcp, notifications]
updated: 2026-08-18
---

长期变更走 subscriptions/listen 开出来的订阅流，客户端要显式勾选想收哪几类。
请求内通知（进度、日志）只走它所属那条请求的响应流，不走订阅流。
