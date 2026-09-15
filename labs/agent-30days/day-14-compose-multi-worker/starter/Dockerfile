# 和 D7 那份 Dockerfile 是同一套规矩（钉版本、先拷依赖清单再拷代码、非 root、
# exec 形式让业务进程成为 PID 1），本天不改。今天新增的只有最后一行注释指出的那件事：
# PID 1 必须自己处理 SIGTERM，否则优雅停机的代码永远不会执行。
FROM node:22-alpine
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml .npmrc ./
# strictDepBuilds=false：pnpm 11 遇到「有依赖的构建脚本被忽略」会以非 0 退出，
# 在容器里这会直接让 docker build 失败（D7 讲过的那个坑）
RUN pnpm install --frozen-lockfile --config.strictDepBuilds=false

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3014
EXPOSE 3014
USER node

# 一个镜像两种角色：compose 里 gateway 用默认 CMD，worker 用 command 覆盖成 start:worker。
# 用 exec 形式直接起 node，让它成为 PID 1 并亲自收到 docker stop 发出的 SIGTERM。
CMD ["node", "--import", "tsx", "src/index.ts"]
