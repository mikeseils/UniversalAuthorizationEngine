# syntax=docker/dockerfile:1

# Stage 1: build
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Every packages/*/tsconfig.json extends ../../tsconfig.json — without this the
# in-image `pnpm run build` fails with TS5083.
COPY tsconfig.json ./
COPY packages ./packages
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    corepack enable && pnpm install --frozen-lockfile && pnpm run build

# Stage 2: run
FROM node:22-alpine
WORKDIR /app
# The workspace uses pnpm symlinked dependencies: per-package node_modules
# point back into the root .pnpm store, and each package.json carries the
# "type": "module" flag Node needs to load dist/*.js as ESM — so copy the
# manifests and the whole packages tree (sources + dist + links), not just
# the data-plane build output.
COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
ENV PORT=3000
EXPOSE 3000
# Non-root: the process only reads the app tree and answers on the network.
USER node
CMD ["node", "packages/data-plane/bin/start.js"]
