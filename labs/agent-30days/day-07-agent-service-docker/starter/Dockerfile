# 基础镜像必须钉版本，不要用 :latest——镜像的价值就在「换台机器结果一样」，
# latest 会在某天悄悄变成下一个大版本，把可复现这件事毁掉。alpine 变体体积更小。
FROM node:22-alpine

# corepack 让 pnpm 的版本也由镜像固定下来，而不是看构建机上装了哪个
RUN corepack enable

WORKDIR /app

# 关键：先只拷贝依赖清单，装完依赖再拷业务代码。
# Docker 逐层缓存，某一层的输入没变就直接复用。改一行 src 只会让最后两层失效，
# pnpm install 那一层照旧命中缓存——构建从几分钟变成几秒。
# 反过来，一上来就 COPY . . 的话，改任何一个字都要把依赖重装一遍。
COPY package.json pnpm-lock.yaml .npmrc ./
# strict-dep-builds=false：pnpm 11 遇到「有依赖的构建脚本被忽略」会以非 0 退出，
# 在容器里这会直接让 docker build 失败。tsx 依赖的 esbuild 二进制由 optional 依赖直接提供，
# 不需要跑构建脚本，所以这里显式关掉这个严格检查。
RUN pnpm install --frozen-lockfile --config.strictDepBuilds=false

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
ENV PORT=3000
# 容器里必须监听 0.0.0.0：只听 127.0.0.1 的话它只在容器内部可达，
# 宿主机 -p 3000:3000 映射进来也连不上。这是容器化的头号新手坑。
ENV HOST=0.0.0.0

# EXPOSE 只是声明意图（给读文档的人和编排工具看），不会真的开端口，
# 真正开放端口的是 docker run -p
EXPOSE 3000

# 别用 root 跑业务进程：容器逃逸时 root 的破坏面大得多。
# node 镜像自带一个非 root 的 node 用户，直接用。
USER node

# 用 exec 形式直接起 node，让它成为 PID 1。
# 写成 CMD ["pnpm", "start"] 的话 PID 1 是包管理器，docker stop 发的 SIGTERM
# 未必能传到 node 进程，于是优雅退出的代码永远不执行，只能等 10 秒超时后被 SIGKILL——
# 对 SSE 这种长连接服务，那意味着所有在途的流被硬生生切断。
CMD ["node", "--import", "tsx", "src/index.ts"]
