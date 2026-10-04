FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
RUN mkdir -p out && chown node:node out
USER node
CMD ["npx", "tsx", "src/server.ts"]
