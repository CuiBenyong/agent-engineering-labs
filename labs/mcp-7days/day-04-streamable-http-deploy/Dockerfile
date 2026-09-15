# 打包 solution/ 里的远程 MCP 服务端。想打 starter 就把 build arg SRC 改成 starter。
FROM node:22-alpine

ARG SRC=solution
WORKDIR /app

# 镜像里用 npm 而不是 pnpm：pnpm 10 以后遇到被拦截的构建脚本（本工程是 esbuild）
# 会以 ERR_PNPM_IGNORED_BUILDS 非 0 退出，本机跑无所谓，但在 RUN 里会直接让镜像构建失败。
# 先只拷依赖清单，让镜像层缓存在改代码时还能命中。tsx 在 devDependencies 里，所以不能加 --omit=dev。
COPY ${SRC}/package.json ./
RUN npm install --no-audit --no-fund

COPY ${SRC}/tsconfig.json ./
COPY ${SRC}/src ./src

# 容器里要绑 0.0.0.0 才能被宿主访问；裸机跑仍然默认只绑回环地址
ENV BIND_HOST=0.0.0.0
ENV PORT=3034
EXPOSE 3034

# 健康检查打的是 /healthz，不是 MCP 端点——MCP 端点只收 POST，用 GET 会拿到 405
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3034/healthz || exit 1

# 用 exec 形式，别套 shell，否则 SIGTERM 传不到 node，优雅停机就失效了
CMD ["npm", "start"]
