# The page for a deployment (docker-compose.yml): the Angular app compiled
# once, served by nginx, which also hands /api to the API container.
#
#   docker build -f docker/deploy/web.Dockerfile -t workbench-web .
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund --loglevel=error
COPY frontend/ ./
RUN npx ng build --configuration production

FROM nginx:1.27-alpine
# nginx's image fills the templates in from the environment at start
# (envsubst), so the API's address and the upload limit are settings.
ENV API_UPSTREAM=api:8000 \
    WEB_MAX_BODY=1g \
    NGINX_ENVSUBST_FILTER="^(API_UPSTREAM|WEB_MAX_BODY)$"
COPY docker/deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /src/dist/frontend/browser /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
