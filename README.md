# Ai4 Agenda Builder

A self-contained "build your personalized agenda" tool for the Ai4 2026 conference website. Built with vanilla JS (no framework dependencies) and a Cloudflare Worker that serves session data from Swapcard and proxies requests to the Anthropic Claude API for personalization.

## Repo Structure

```
ai4-agenda-builder/
├── agenda-builder.html  ← WordPress embed (drop into a Custom HTML block)
└── worker/
    ├── worker.js          ← Cloudflare Worker source (Swapcard data + Claude proxy)
    └── wrangler.toml       ← Deployment config
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
