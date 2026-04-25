# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build

# Stage 2: Production
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY --from=builder /app/dist/ ./dist/
# CHANGELOG.md is read at runtime by src/scripts/agent-forum-post.ts::generateRelease()
# via src/lib/changelog-parser.ts — ship it inside the image so the script no
# longer needs the `git` CLI (which alpine node:20-alpine does not include).
COPY CHANGELOG.md ./
# INTEGRATIONS-W1 C6 — landing/integrations/*.html pre-rendered mirrors
# read at startup by the /docs/integrations/:exchange route in dist/index.js.
# Limited to landing/integrations/ only (rest of landing/ is served by Caddy
# as static, not by Express).
COPY landing/integrations/ ./landing/integrations/
EXPOSE 3000
ENV TRANSPORT=http
USER node
CMD ["node", "dist/index.js"]
