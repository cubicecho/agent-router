# syntax=docker/dockerfile:1

# The worker package (`npm run build:worker`): one bundled file and its manifest. Built on the build machine's own
# platform, since the bundle is the same JavaScript on every one.
FROM --platform=$BUILDPLATFORM node:26-slim AS worker-package
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:worker

# Optional: docker build --target test
FROM worker-package AS test
CMD ["npm", "test"]

# The worker program, on its own: `docker build --target worker`. It runs a workspace's agent loops on another
# machine and reaches the router only over HTTP, so it carries only the worker package and its dependencies, the
# same package `npm run pack:worker` makes.
FROM node:26-slim AS worker
WORKDIR /app
# git for workdir's open_repo, which clones; ssh for a repo named like git@host:owner/name.git.
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=worker-package /app/dist-worker ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
ENV NODE_ENV=production
# Where its work directories go: a volume, so checkouts outlive the container.
ENV WORKER_ROOT=/work
RUN mkdir -p /work && chown node:node /work
VOLUME /work
USER node
CMD ["node", "worker.js"]

# The standalone host. Last, so a plain `docker build` makes it.
FROM node:26-slim AS runtime
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# The server isn't compiled: its sources are the build output. Migrations apply at boot.
COPY server server
COPY drizzle drizzle

ENV NODE_ENV=production
ENV PORT=3100
EXPOSE 3100
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form, so node is PID 1 and gets SIGTERM itself.
CMD ["node", "server/index.ts"]
