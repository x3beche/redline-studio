# Deploying

[← back to the README](README.md) · [Installing for development](INSTALL.md)

`docker-compose.yml` runs Workbench as a server: MongoDB, the API, the page,
and the images the API does its work in. Everything is set with environment
variables - a `.env` file for `docker compose`, the stack's variables in
Portainer. Only Docker is needed on the machine (Engine 24+, Compose v2.20+).

For development with live reload, use `./start.sh` or `compose.dev.yml`
([INSTALL.md](INSTALL.md)) - not this file.

## What runs

| service | image | what it is |
|---|---|---|
| `web` | `…-web` (nginx) | the compiled page; `/api/` is passed to the API, streams unbuffered. The **one published port** |
| `api` | `…-api` | FastAPI under uvicorn, atopile in its own environment, the docker CLI |
| `mongo` | `mongo:7.0` | the database - the source of truth for everything |
| `draw` | `…-draw` | technical drawings and Taste renders; built, then exits |
| `kicad` | `…-kicad` | profile `kicad`: the board room's placing, routing (Freerouting), DRC, schematics, release outputs - 8 GB |
| `firmware` | `…-firmware` | profile `firmware`: PlatformIO with the ESP32 platform, for the Firmware room - 2 GB |
| `tools` | `…-tools` | profile `tools`: the Tools tab's Check (PostgreSQL, TypeScript, Prisma, Mermaid…) - 2.4 GB |
| `tracemaker` | `…-tracemaker` | profile `tracemaker`: routing with TraceMaker instead of Freerouting |
| `chrome` | `zenika/alpine-chrome` | profile `pdf`: headless Chromium for the Chat's PDFs (pulled) |

Profile `full` turns on all of them. The app works without any profile: a
room whose image is missing says so and what to build.

The work services (`draw`, `kicad`, …) do not stay running: compose builds or
pulls their image and they exit at once (status *Exited (0)* is right). The
API starts them, one container per job, through the host's Docker socket.

That is also why the API needs **`REDLINE_HOST_DIR`**, a host directory
mounted at the *same path* inside the API container: the API hands its work
containers paths, and the host has to have them. On every start the API
copies its code into `REDLINE_HOST_DIR/app` and runs from there; its caches
(`app/.cache`), scratch (`tmp/`) and the secret key (`secrets/`) live there
too. It must be an absolute path. Mounting the Docker socket gives the API
control of the host's Docker - run it only on a machine meant for it.

## With docker compose

```bash
git clone https://github.com/x3beche/redline-studio.git workbench
cd workbench
cp deploy.env.example .env
$EDITOR .env           # MONGO_ROOT_PASSWORD, REDLINE_HOST_DIR, owner, secret key
docker compose up -d --build
docker compose ps      # web and api "healthy" after a minute or two
```

The page is on `http://<host>:8080` (`WORKBENCH_PORT`). The first build
takes a while (build123d, atopile, the Angular build); add the work images
you want with `COMPOSE_PROFILES=kicad,firmware` in `.env`, then
`docker compose up -d --build` again.

`REDLINE_HOST_DIR` (default `/var/lib/workbench`) is created by Docker if it
does not exist; the API makes what it needs inside it.

## With Portainer

**Repository stack (builds from git).** Stacks > Add stack > *Repository*:

- Repository URL: this repository; reference `refs/heads/main` (or a tag);
  compose path `docker-compose.yml`.
- Environment variables: the required ones from `deploy.env.example`
  (*Load variables from .env file* takes the file as it is). Add
  `COMPOSE_PROFILES` for the work images you want.
- Deploy. Portainer clones the repository and builds the images on the host;
  the first deploy takes several minutes.

To update: *Pull and redeploy* on the stack (tick *Re-pull image* only when
using registry images), or turn on GitOps updates.

**Web editor stack (prebuilt images).** With images published to a
registry (`.github/workflows/images.yml` pushes them to GHCR on a `v*` tag),
paste `docker-compose.yml` into the web editor and set, besides the required
variables:

```
REDLINE_IMAGE_PREFIX=ghcr.io/x3beche/workbench
REDLINE_VERSION=1.0.0
```

Compose then pulls the images instead of building them (the `build:`
sections are only used for an image that is not there). Private packages
need the registry added under Portainer's *Registries*.

## The first sign-in

Sign-in is on (`REDLINE_REQUIRE_SIGNIN=true`). With `REDLINE_OWNER_EMAIL` and
`REDLINE_OWNER_PASSWORD` (10+ characters) set, the owner's account is made on
the first start; once any account exists they are ignored, and you may clear
them. Without them, the first person to open the page is asked to make the
owner's account - do it before others can reach the page. The owner and
admins add everyone else ([docs/ACCOUNTS.md](docs/ACCOUNTS.md)). Model API keys are typed in
the app, Settings > LLM settings, never in the environment.

## Updating

```bash
git pull
docker compose up -d --build        # or, with registry images:
docker compose pull && docker compose up -d
```

Data stays: MongoDB is in its volume and `REDLINE_HOST_DIR` is untouched
except `app/`, which is replaced with the new code on start.

## Backups

| what | where | how |
|---|---|---|
| the database (everything: models, boards, files in GridFS, accounts) | volume `<project>_mongo-data` | `docker compose exec mongo sh -c 'mongodump --archive --gzip -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin' > workbench-$(date +%F).archive.gz` |
| the secret key (when `REDLINE_SECRET_KEY` is unset) | `REDLINE_HOST_DIR/secrets/secret.key` | copy it, kept apart from the database dumps |
| caches (build cache, drawings, firmware `.pio`) | `REDLINE_HOST_DIR/app/.cache` | optional - all of it is made again |

Restore: `docker compose exec -T mongo sh -c 'mongorestore --archive --gzip --drop -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin' < workbench-….archive.gz`.

`docker compose down` keeps the volumes; `down -v` deletes the database.

## HTTPS and a reverse proxy

The stack speaks plain HTTP on one port; put a TLS proxy in front for
anything beyond a trusted network. Set `WORKBENCH_BIND=127.0.0.1` when the
proxy runs on the same host, and point it at `http://127.0.0.1:8080`. The
proxy must:

- pass `X-Forwarded-Proto` (the session cookie is marked Secure from it);
- not buffer responses, or the Chat's answers and build progress arrive all
  at once at the end (nginx: `proxy_buffering off;`, a long
  `proxy_read_timeout`, e.g. `3600s`);
- allow large uploads (STEP files): nginx `client_max_body_size 1g;`.

Caddy needs only `reverse_proxy 127.0.0.1:8080` (with `flush_interval -1`).
In Nginx Proxy Manager, add the proxy host and the nginx lines above under
*Advanced*.

## When something is wrong

- `docker compose logs -f api` - the API's log; `web` shows nginx's.
- The API stays *starting*: it waits for MongoDB; check `docker compose logs mongo`.
- A room says its image is not built: add its profile and
  `docker compose up -d --build`.
- "no Docker socket" in the API's log: the socket is not mounted
  (`DOCKER_SOCKET`, rootless Docker: `$XDG_RUNTIME_DIR/docker.sock`).
- A changed `MONGO_ROOT_PASSWORD` does nothing to an existing database:
  MongoDB takes it only when its volume is first made.
