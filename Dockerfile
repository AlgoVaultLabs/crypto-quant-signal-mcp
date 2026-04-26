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
# WEBSITE-REFRESH-W1 C4 — landing/skills.html read at startup by the
# /skills route in dist/index.js. Both live under landing/ but Caddy serves
# the static landing pages (index/docs/verify/privacy) directly from
# /var/www/algovault. Express serves the dynamic /docs/integrations/* +
# /skills routes from the in-image copy below.
COPY landing/integrations/ ./landing/integrations/
COPY landing/skills.html ./landing/skills.html
EXPOSE 3000
ENV TRANSPORT=http
USER node
CMD ["node", "dist/index.js"]
