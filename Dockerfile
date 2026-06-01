FROM node:20-alpine AS deps

WORKDIR /app
ENV PYTHON=/usr/bin/python3

RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY bridge.js ./

RUN addgroup -S app && adduser -S -G app app
USER app

CMD ["node", "bridge.js"]
