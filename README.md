# Ai4 Agenda Builder

A self-contained "build your personalized agenda" tool for the Ai4 2026 conference website. Built with vanilla JS (no framework dependencies) and a Cloudflare Worker that serves session data from Swapcard and proxies requests to the Anthropic Claude API for personalization.

## Repo Structure

```
ai4-agenda-builder/
├── agenda-builder.html  ← WordPress embed (drop into a Custom HTML block)
├── worker.js            ← Cloudflare Worker (Swapcard data + Claude proxy + site routing)
├── seo.js               ← Server-side rendering: full agenda + session pages on ai4.com
└── wrangler.toml        ← Deployment config
```

---

## Making Changes

### 1 — Clone & edit locally

```bash
git clone https://github.com/ai4conferences/ai4-agenda-builder.git
cd ai4-agenda-builder
```

Edit `agenda-builder.html` (styles + JS logic) or `worker/worker.js` (Swapcard data + Claude proxy) in any text editor or VS Code.

### 2 — Push changes to GitHub

```bash
git add .
git commit -m "describe what you changed"
git push
```

### 3 — Deploy the Worker (only needed when worker.js changes)

```bash
cd worker
npm install -g wrangler   # first time only
wrangler login             # first time only

wrangler deploy --env staging      # test in staging first
wrangler deploy --env production   # promote to production
```

### 4 — Update the WordPress embed (only needed when agenda-builder.html changes)

1. In WordPress, find the **Custom HTML** block containing the Agenda Builder.
2. Replace the entire block contents with the updated `agenda-builder.html`.
3. Make sure the Worker URLs near the top of the `<script>` block (the `/sessions` fetch and `CLAUDE_API_URL`) still point at your production Worker.
4. Update & preview.

---

## Server-side rendering (SEO / LLM readability)

The builder is a questionnaire, so its page had no session content for search
engines or LLMs. The production Worker also runs on `ai4.com/agenda-builder*`
and `ai4.com/sessions*` and adds real HTML as the static WordPress page
streams through (Cloudflare `HTMLRewriter`). Code: `seo.js`.

| URL | What it serves |
|---|---|
| `/agenda-builder/` | The builder page + a day-by-day "Browse the full agenda" list (collapsed `<details>`, fully in the HTML) + `ItemList` JSON-LD |
| `/sessions/<slug>/` | A page per session with a description or speakers: time, room, type/track, description, speakers (→ `/speakers/<slug>/`), sponsors (→ `/sponsors-exhibitors/<slug>/`), "See details & bookmark in the Ai4 app" (Swapcard), `Event` JSON-LD |
| `/sessions/?id=<Swapcard planning id>` | 301 to that session's page (or Swapcard for breaks/lunches), so other widgets can link by id |
| `/sessions/sitemap.xml` | Sitemap of session pages |
| `/sessions.md` | Full agenda as markdown for LLMs |

- Same HTML for everyone (no bot detection). Any failure passes the page through untouched; page views never wait on Swapcard.
- The `/sessions` JSON the builder sends to Claude is unchanged; the pages use a separate, fuller cached copy.
- Speaker and sponsor links use service bindings (`SPEAKERS` → `ai4-speakers`, `SPONSORS` → `ai4-sponsors-prod`).
- Debug header: `X-Agenda-SSR: agenda | session | bypass-cold | sitemap | markdown`.
- `agenda-builder.html` now wraps everything in `<div id="ai4-agenda-builder">` with an empty `<div id="ai4-agenda-full">` slot; session pages swap that wrapper for the session.

### Deploy
```bash
npx wrangler deploy --env production
curl -sI -A "Mozilla/5.0" https://ai4.com/agenda-builder/ | grep -i x-agenda-ssr
```
Then paste `agenda-builder.html` into the WordPress block, regenerate the static site, and submit `https://ai4.com/sessions/sitemap.xml` in Search Console.

---

## Worker Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SWAPCARD_API_KEY` | ✅ | Swapcard API key — set as a **secret** via `wrangler secret put` |
| `ANTHROPIC_API_KEY` | ✅ | Anthropic API key — set as a **secret** via `wrangler secret put` |

`COMMUNITY_ID` and `EVENT_ID` are hardcoded near the top of `worker.js` — update them there if this is ever pointed at a different Swapcard community/event.

---

## Branding

The header badge and the "Register Now" footer link use `--accent-orange: #ffbb7f` (Ai4 orange), and the step labels / intro copy / footer text use `--text-bright: #c8cbef` for extra contrast against the dark background. Both are defined as CSS variables near the top of `agenda-builder.html`, so either can be tweaked in one place.

---

## Changelog

| Version | Notes |
|---|---|
| v1 | Initial GitHub setup. Badge + "Register Now" link recolored to Ai4 orange (`#ffbb7f`); step labels, intro copy, and footer text brightened (`#c8cbef`) for better contrast. |
