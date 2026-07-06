FROM node:22-alpine AS base
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npx prisma generate && npm run build

EXPOSE 3001
# Apply any pending Prisma migrations BEFORE booting, so the generated client
# never selects columns/enums the DB lacks (that ships a 500 on every query for
# the affected table). migrate deploy is idempotent and takes an advisory lock,
# so it is safe to run on each container start.
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
