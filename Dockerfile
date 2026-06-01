FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# 先装依赖(利用层缓存)。better-sqlite3 在 linux 有预编译二进制,通常无需编译工具。
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# 再拷贝源码与后台静态资源
COPY src ./src
COPY public ./public

# 数据目录(compose 会把宿主 ./data 挂载到这里以持久化 SQLite)
RUN mkdir -p /app/data

EXPOSE 3000
CMD ["node", "src/app.js"]
