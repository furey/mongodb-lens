FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --no-fun --no-audit

COPY . .

EXPOSE 3000

CMD ["node", "mongodb-lens.js"]
