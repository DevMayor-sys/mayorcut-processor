FROM node:18-slim
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json .
RUN npm install
COPY . .
RUN mkdir -p uploads processed temp
EXPOSE 8080
CMD ["node", "server.js"]
