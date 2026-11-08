# Pañol 3: imagen de la app (Fastify + la app web compilada).
# Etapa 1: dependencias completas y compilación de web/ (Vite, xlsx y jspdf a vendor/).
# Etapa 2: solo dependencias de producción, usuario sin privilegios, NODE_ENV=production.
FROM node:22.22-alpine AS build
WORKDIR /app
# Por si argon2 no trae binario para musl y hay que compilarlo (solo en esta etapa).
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY vite.config.js ./
COPY web ./web
RUN npm run build
# Se quitan las dependencias de desarrollo (vite, embedded-postgres, xlsx, jspdf…).
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:22.22-alpine AS app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    TZ=America/Argentina/Buenos_Aires
WORKDIR /app
RUN apk add --no-cache tzdata
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/web/dist ./web/dist
COPY --chown=root:root package.json package-lock.json ./
COPY --chown=root:root server/src ./server/src
COPY --chown=root:root server/migrations ./server/migrations
COPY --chown=root:root server/scripts ./server/scripts
COPY --chown=root:root server/pg-version.json ./server/pg-version.json
# El código es de root y solo de lectura para la app; corre con el usuario `node` (uid 1000).
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/src/main.js"]
