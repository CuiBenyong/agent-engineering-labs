# 本地加载与触发记录

## 加载方式

开发期不发布也不安装，直接把本地目录挂进去：

```bash
claude --plugin-dir ./team-conventions
```

改完 SKILL.md 之后跑一次重载命令即可，不必重启。

## 结构自检

发包前先跑一次结构自检（正文里那段脚本），确认三件事：清单在专用目录里、组件目录没被塞进清单目录、每个 skill 都有描述。

```text
$ node check-pack.js ./team-conventions
✅ 没有发现问题
```

第一次跑的时候它报了一条，值得记下来：

```text
❌ skills/ 必须放在插件根下，不能放进 .claude-plugin/
```

症状正是官方文档说的那种——包装上了，技能一个都不出现，而且没有任何报错。

## 触发记录

| 说的那句话                                 | 期望触发       | 实际触发       | 调用名                            | 结论                     |
| ------------------------------------------ | -------------- | -------------- | --------------------------------- | ------------------------ |
| 这几个文件我要提交了，帮我写个提交信息     | commit-message | commit-message | `team-conventions:commit-message` | 通过                     |
| 帮我看看这个改动有没有问题，写几条评审意见 | code-review    | code-review    | `team-conventions:code-review`    | 通过                     |
| 这一版要上线了，写个发布说明               | release-report | release-report | `team-conventions:release-report` | 通过                     |
| 帮我把这几个提交合成一个                   | 都不触发       | 都不触发       | 无                                | 通过，这是操作不是文本   |
| 帮我把这段代码格式化一下                   | 都不触发       | 都不触发       | 无                                | 通过，确定性的事交给工具 |

## 命名空间验证

三个技能的调用名都带上了包名前缀。为了确认命名空间真的在起作用，我另建了一个只有一个 `commit-message` 的小包同时挂上，两个都能各自调用、互不覆盖，调用名分别是 `team-conventions:commit-message` 与 `scratch-pack:commit-message`。

**结论**：撞名问题在包这一层就解决了，不需要给技能起加前缀的怪名字。
