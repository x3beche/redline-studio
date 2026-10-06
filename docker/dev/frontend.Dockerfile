# Development image for the UI: Node only. The source is mounted, `ng serve`
# rebuilds on every edit, and node_modules lives in a volume that
# frontend.sh refreshes when package-lock.json changes.
FROM node:22-bookworm-slim

# The volume takes this directory's owner the first time it is created,
# so npm can write it as the unprivileged `node` user (uid 1000).
ARG APP=/app
RUN mkdir -p $APP/frontend/node_modules && chown -R node:node $APP
USER node
