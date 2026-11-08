# QNS Memory Verses

A single-page site of memory verses for each QNS session, published with GitHub Pages.

## How it works

- `index.html` is the whole site. The KJV and BSB (both public domain) are built in.
- On every push, every Monday, and on demand, the **Deploy site** workflow
  (`.github/workflows/deploy.yml`) publishes the site and, on the way, adds the ESV, CSB
  and NASB using `scripts/fetch-licensed.mjs`. The licensed text is never committed here.
- A translation whose key is missing is simply left out; the site still deploys.

## One-time setup

1. **Settings → Secrets and variables → Actions → Secrets → New repository secret**
   - `ESV_API_KEY` — from https://api.esv.org
   - `API_BIBLE_KEY` — from https://api.bible (free Starter plan, with CSB and NASB enabled)
2. **Settings → Pages → Build and deployment → Source: GitHub Actions**
3. **Actions → Deploy site → Run workflow** (or push any change).

## Changing the verses

Edit the session list (and KJV/BSB text) in `scripts/build/verses.py`, then run
`python3 scripts/build/build.py` to regenerate `index.html`.
