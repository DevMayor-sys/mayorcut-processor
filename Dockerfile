# MayorCut Processor — full FFmpeg build
# node:20 fixes the SDK deprecation; apt ffmpeg gives ALL filters (drawtext, etc.)
FROM node:20-slim

# Full FFmpeg + a font for drawtext (watermark, captions)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
