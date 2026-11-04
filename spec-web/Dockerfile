# spec-web — zero-runtime-dependency Node wrapper around tools/spec/spec.mjs.
#
# No app code is baked into this image on purpose. The whole repo is bind-
# mounted at /repo at container start (see docker-compose.yml), so the
# container always runs whatever is actually on disk right now — CLAUDE.md,
# tools/spec/spec.mjs, tools/spec-web itself — and every write it makes goes
# straight to the real files on the host, not a copy frozen at build time.
# That is the same "the CLI is the only writer" guarantee documented in
# README.md, just extended to hold across a container boundary too.
FROM node:20-alpine
RUN apk add --no-cache git

WORKDIR /repo

EXPOSE 8888 8889

# --host 0.0.0.0 is required here specifically: Docker's published-port proxy
# forwards to the container's external interface, not its loopback, so a bare
# `node server.mjs` (which defaults to 127.0.0.1, on purpose, for the non-
# container case) would be completely unreachable from outside the container
# even with the port published.
ENTRYPOINT ["node", "tools/spec-web/server.mjs"]
CMD ["--host", "0.0.0.0", "--port", "8888"]
