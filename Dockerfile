# Build stage
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy package files
COPY package.json bun.lock ./

# Install dependencies (including devDependencies for build)
ARG GH_PACKAGES_TOKEN
RUN echo "@sudobility:registry=https://npm.pkg.github.com" > ~/.npmrc && \
    echo "//npm.pkg.github.com/:_authToken=${GH_PACKAGES_TOKEN}" >> ~/.npmrc && \
    bun install --frozen-lockfile && \
    rm ~/.npmrc

# Copy source code
COPY src ./src
COPY tsconfig.json ./

# Type check
RUN bunx tsc --noEmit

# Production stage
FROM oven/bun:1-slim AS production

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package.json bun.lock ./

# Install production dependencies only
ARG GH_PACKAGES_TOKEN
RUN echo "@sudobility:registry=https://npm.pkg.github.com" > ~/.npmrc && \
    echo "//npm.pkg.github.com/:_authToken=${GH_PACKAGES_TOKEN}" >> ~/.npmrc && \
    bun install --frozen-lockfile --production && \
    rm ~/.npmrc

# Copy source code (Bun runs TypeScript directly)
COPY src ./src

# Set environment
ENV NODE_ENV=production

# Expose port
EXPOSE 8010

# Start the application
CMD ["bun", "run", "src/index.ts"]
