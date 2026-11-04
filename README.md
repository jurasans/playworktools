# tools/

Everything that is not the app itself, grouped by what it is for. Run everything from the repo root (`node tools/<group>/<file>`, or the `npm run` names in `package.json`).

| Folder | What it is for | Main entry points |
|---|---|---|
| `build/` | Making the app: Android and iOS builds, the web dev build, icons, the asset manifest, image compression, logcat | `playwork-build.js` (`npm run build:android`), `build-android.sh`, `build-ios.sh`, `build-web-dev.mjs`, `gen-asset-manifest.mjs`, `generate-icons.mjs` |
| `spec/` | The work around the spec: stub registry CLI, work items, nightly run, headless agent runs, test-run recording | `spec.mjs` (`npm run spec`), `work.mjs`, `nightly-run.mjs` (`npm run nightly`), `agent-run.mjs`, `host-runner.mjs` (`npm run spec:host-runner`), `run-full-suite.mjs` |
| `i18n/` | Translations: merging model output into `strings.csv`, extracting chunks, translating the in-app manual | `merge-translations.mjs`, `extract-translation-chunk.mjs`, `manual-translate.mjs`, `csv-merge.mjs` (shared) |
| `generate/` | Local art and audio generation (ComfyUI in Docker): generators, prompt files, the Space Chase art pipeline, and the queue runners that spec-web uses | `generate*.mjs`, `spacechase-*.mjs`, `gen-queue-runner.mjs`, `image-gen-runner.mjs`, `audio-gen-runner.mjs`, `README.md` |
| `spec-web/` | The spec dashboard (Docker): server, pages, state and documentation | `server.mjs`, `README.md` |

Rules of thumb:
- A script reaches the repo root with `resolve(HERE, '..', '..')` (they all sit two levels down). Shared helpers live next to their users or in `spec-web/*-lib.mjs`.
- `generate/` keeps its heavy machine-local folders (`basedir/`, `run/`, `data/`, `node_modules/`) in place; they are git-ignored and mounted by `generate/docker-compose.yml`.
- `android/` and `ios/` are regenerated; edit native plugin code under `src/plugins/`, never there.
