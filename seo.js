// seo.js — server-side rendering for the Ai4 agenda on ai4.com
// ===============================================================
// The agenda builder is a questionnaire, so its page has no session content
// for search engines or LLMs. When this Worker is routed on the site, it:
//
//   /agenda-builder/          → the WordPress page + a pre-rendered, day-by-day
//                               "Full agenda" list (in a <details> under the
//                               builder) + ItemList JSON-LD
//   /sessions/<slug>/         → a page per session (time, room, track,
//                               description, speakers → /speakers/, sponsors →
//                               /sponsors-exhibitors/, Event JSON-LD)
//   /sessions/?id=<planning>  → 301 to that session's page (lets other widgets
//                               link by Swapcard id)
//   /sessions/sitemap.xml     → sitemap of session pages
//   /sessions.md              → the full agenda as markdown for LLMs
//
// Everyone gets the same HTML (no bot sniffing). Any failure passes the page
// through to WordPress untouched.

const SLUGGED = new WeakSet();
const lookups = { speakers: null, sponsors: null }; // { at, map }

// ---------- entry points ----------

export function isSiteRequest(url, env) {
  const host = url.hostname.toLowerCase();
  const hosts = (env.SITE_HOSTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return hosts.some((h) => (h.endsWith(".*") ? host.startsWith(h.slice(0, -1)) : host === h));
}

/** data.loadAgenda(env, ctx, { allowCold }) → { sessions, generatedAt } | null */
export async function handleSite(request, env, ctx, data) {
  let res = await routeSite(request, env, ctx, data);
  if (env.NOINDEX === "true") {
    res = new Response(res.body, res);
    res.headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  return res;
}

async function routeSite(request, env, ctx, data) {
  if (request.method !== "GET" && request.method !== "HEAD") return originFetch(request, env);
  const url = new URL(request.url);
  const agenda = pathSetting(env.AGENDA_PATH, "/agenda-builder/");
  const sessions = pathSetting(env.SESSIONS_PATH, "/sessions/");
  const p = url.pathname;
  try {
    if (p === agenda) return await renderAgendaPage(request, env, ctx, data);
    if (p === sessions && url.searchParams.get("id")) return (await redirectById(request, env, ctx, data, url.searchParams.get("id"))) || originFetch(request, env);
    if (p === sessions + "sitemap.xml") return (await renderSitemap(request, env, ctx, data)) || originFetch(request, env);
    if (p === sessions.replace(/\/$/, "") + ".md") return (await renderMarkdown(request, env, ctx, data)) || originFetch(request, env);
    if (p.startsWith(sessions)) {
      const m = p.slice(sessions.length).match(/^([a-z0-9-]+)(\/?)$/);
      if (m) {
        const res = await renderSessionPage(request, env, ctx, data, m[1], m[2] === "/");
        if (res) return res;
      }
    }
  } catch (err) {
    console.error("[seo] render failed, passing through:", (err && err.stack) || err);
  }
  return originFetch(request, env);
}

// ---------- slugs & selection ----------

export function slugify(s) {
  return String(s || "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "") || "session";
}

/** Adds `slug` to every session (lowest id keeps the plain slug on a title clash). */
export function withSlugs(sessions) {
  if (!Array.isArray(sessions) || SLUGGED.has(sessions)) return sessions;
  const groups = new Map();
  for (const s of sessions) {
    const b = slugify(s.title);
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b).push(s);
  }
  for (const [b, list] of groups) {
    list.sort((a, c) => String(a.id).localeCompare(String(c.id)));
    list.forEach((s, i) => { s.slug = i === 0 ? b : `${b}-${slugify(String(s.id)).slice(-6)}`; });
  }
  SLUGGED.add(sessions);
  return sessions;
}

// Sessions with something to say get their own page; breaks/lunches don't.
function hasPage(s) {
  return !!(plain(s.description) || (s.speakers && s.speakers.length));
}

// ---------- agenda page ----------

async function renderAgendaPage(request, env, ctx, data) {
  const loaded = await data.loadAgenda(env, ctx, { allowCold: false });
  if (!loaded || !loaded.sessions.length) return tag(await originFetch(request, env), "bypass-cold");

  const origin = await originFetch(request, env);
  if (!origin.ok || !isHtml(origin)) return origin;

  const sessionsBase = pathSetting(env.SESSIONS_PATH, "/sessions/");
  const siteOrigin = siteOriginFor(request, env);
  const sessions = sortByTime(withSlugs(loaded.sessions).slice());
  const listHtml = fullAgendaHtml(sessions, env, sessionsBase);
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `${eventLabel(env)} agenda`,
    numberOfItems: sessions.filter(hasPage).length,
    itemListElement: sessions.filter(hasPage).map((s, i) => ({ "@type": "ListItem", position: i + 1, url: siteOrigin + sessionsBase + s.slug + "/", name: s.title })),
  };

  let filled = false;
  const fill = (el) => { if (filled) return; filled = true; el.setInnerContent(listHtml, { html: true }); };
  const rw = new HTMLRewriter()
    // New block markup has an empty <div id="ai4-agenda-full"> slot…
    .on("#ai4-agenda-full", { element(el) { el.setAttribute("data-ssr", String(sessions.length)); fill(el); } })
    // …older markup doesn't, so fall back to inserting after the popup.
    .on("#popupOverlay", { element(el) { el.onEndTag((end) => { if (!filled) { filled = true; end.after(`<div id="ai4-agenda-full" data-ssr="${sessions.length}">${listHtml}</div>`, { html: true }); } }); } })
    .on("head", {
      element(el) {
        el.append(`<link rel="alternate" type="text/markdown" href="${esc(sessionsBase.replace(/\/$/, "") + ".md")}" title="Full agenda (markdown)">` + ldScript(jsonLd), { html: true });
      },
    });
  return tag(cleanHeaders(rw.transform(origin)), "agenda");
}

function fullAgendaHtml(sessions, env, sessionsBase) {
  const byDay = new Map();
  for (const s of sessions) {
    const d = dayKey(s.beginsAt);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(s);
  }
  const parts = [];
  parts.push(`<details class="ai4-af"><summary>Browse the full ${esc(eventLabel(env))} agenda (${sessions.length} sessions)</summary>`);
  for (const [day, list] of byDay) {
    parts.push(`<h2 class="ai4-af-day">${esc(dayLabel(list[0].beginsAt) || day)}</h2><ul class="ai4-af-list">`);
    for (const s of list) {
      const href = hasPage(s) ? sessionsBase + s.slug + "/" : s.swapcard_url;
      const meta = [s.track, s.place].filter(Boolean).map(esc).join(" · ");
      parts.push(
        `<li><time datetime="${esc(isoWithOffset(s.beginsAt, env))}">${esc(timeLabel(s.beginsAt))}</time>` +
        `<div><a href="${esc(href)}"${hasPage(s) ? "" : ' target="_blank" rel="noopener"'}>${esc(s.title)}</a>` +
        (s.speakers && s.speakers.length ? `<span class="ai4-af-sp">${s.speakers.map((p) => esc(p.name)).join(", ")}</span>` : "") +
        (meta ? `<span class="ai4-af-meta">${meta}</span>` : "") + `</div></li>`
      );
    }
    parts.push(`</ul>`);
  }
  parts.push(`</details>`);
  parts.push(`<style>
    #ai4-agenda-full { max-width: 820px; margin: 0 auto; padding: 0 24px 64px; }
    #ai4-agenda-full .ai4-af { border: 1px solid var(--border, #1c2044); border-radius: 12px; background: var(--bg-card, #0f1228); padding: 4px 20px; color: var(--text-primary, #f0f0f8); }
    #ai4-agenda-full .ai4-af summary { cursor: pointer; padding: 14px 0; font-family: var(--font-display, sans-serif); font-weight: 600; font-size: 15px; color: var(--text-bright, #c8cbef); }
    #ai4-agenda-full .ai4-af-day { font-family: var(--font-display, sans-serif); font-size: 18px; font-weight: 700; margin: 20px 0 8px; color: var(--accent-orange, #ffbb7f); }
    #ai4-agenda-full .ai4-af-list { list-style: none; margin: 0 0 12px; padding: 0; }
    #ai4-agenda-full .ai4-af-list li { display: grid; grid-template-columns: 76px 1fr; gap: 12px; padding: 10px 0; border-top: 1px solid var(--border, #1c2044); font-size: 14px; }
    #ai4-agenda-full .ai4-af-list time { color: var(--text-secondary, #9396b0); font-variant-numeric: tabular-nums; }
    #ai4-agenda-full .ai4-af-list a { color: var(--text-primary, #f0f0f8); font-weight: 600; text-decoration: none; }
    #ai4-agenda-full .ai4-af-list a:hover { text-decoration: underline; }
    #ai4-agenda-full .ai4-af-sp, #ai4-agenda-full .ai4-af-meta { display: block; color: var(--text-secondary, #9396b0); font-size: 13px; }
    #ai4-agenda-full .ai4-af-meta { color: var(--text-muted, #565a78); }
  </style>`);
  return parts.join("");
}

// ---------- session pages ----------

async function redirectById(request, env, ctx, data, id) {
  const loaded = await data.loadAgenda(env, ctx, { allowCold: true });
  const s = loaded && withSlugs(loaded.sessions).find((x) => x.id === id);
  if (!s) return null;
  const target = hasPage(s) ? new URL(pathSetting(env.SESSIONS_PATH, "/sessions/") + s.slug + "/", request.url).toString() : s.swapcard_url;
  return Response.redirect(target, 301);
}

async function renderSessionPage(request, env, ctx, data, slug, hasSlash) {
  const loaded = await data.loadAgenda(env, ctx, { allowCold: true });
  if (!loaded) return null;
  const s = withSlugs(loaded.sessions).find((x) => x.slug === slug);
  if (!s || !hasPage(s)) return null; // unknown → WordPress handles it

  const sessionsBase = pathSetting(env.SESSIONS_PATH, "/sessions/");
  if (!hasSlash) {
    const u = new URL(request.url);
    u.pathname = sessionsBase + slug + "/";
    return Response.redirect(u.toString(), 301);
  }

  const [speakerSlugs, sponsorSlugs] = await Promise.all([
    s.speakers && s.speakers.length ? getSpeakerSlugs(env) : null,
    s.exhibitors && s.exhibitors.length ? getSponsorSlugs(env) : null,
  ]);
  const descHtml = s.description ? await sanitizeHtml(s.description) : "";

  const agendaPath = pathSetting(env.AGENDA_PATH, "/agenda-builder/");
  const shellHeaders = new Headers(request.headers);
  ["if-none-match", "if-modified-since", "range"].forEach((h) => shellHeaders.delete(h));
  const shell = await originFetch(new Request(new URL(agendaPath, request.url).toString(), { method: "GET", headers: shellHeaders, redirect: "follow" }), env);
  if (!shell.ok || !isHtml(shell)) return null;

  const siteOrigin = siteOriginFor(request, env);
  const canonical = siteOrigin + sessionsBase + s.slug + "/";
  const title = `${s.title} – ${eventLabel(env)}`;
  const when = longWhen(s.beginsAt, s.endsAt);
  const description = truncate(`${when ? when + ". " : ""}${plain(s.description) || (s.speakers || []).map((p) => p.name).join(", ")}`, 160);
  const speakersBase = env.SPEAKERS_PAGE_BASE || "/speakers/";
  const sponsorsBase = env.SPONSORS_PAGE_BASE || "/sponsors-exhibitors/";

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Event",
    name: s.title,
    url: canonical,
    startDate: isoWithOffset(s.beginsAt, env) || undefined,
    endDate: isoWithOffset(s.endsAt, env) || undefined,
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    eventStatus: "https://schema.org/EventScheduled",
    description: plain(s.description) ? truncate(plain(s.description), 500) : undefined,
    location: {
      "@type": "Place",
      name: [s.place, env.VENUE_NAME || "The Venetian Resort Las Vegas"].filter(Boolean).join(", "),
      address: env.VENUE_ADDRESS || "3355 S Las Vegas Blvd, Las Vegas, NV 89109, USA",
    },
    performer: (s.speakers || []).map((p) => {
      const slugP = speakerSlugs && speakerSlugs.get(p.name.toLowerCase());
      return { "@type": "Person", name: p.name, jobTitle: p.jobTitle || undefined, worksFor: p.organization ? { "@type": "Organization", name: p.organization } : undefined, url: slugP ? siteOrigin + speakersBase + slugP + "/" : undefined };
    }),
    sponsor: (s.exhibitors || []).map((x) => {
      const sp = sponsorSlugs && sponsorSlugs.get(x.id);
      return { "@type": "Organization", name: x.name, url: sp ? siteOrigin + sponsorsBase + sp + "/" : undefined };
    }),
    organizer: { "@type": "Organization", name: "Ai4", url: siteOrigin + "/" },
    superEvent: { "@type": "Event", name: eventLabel(env), url: siteOrigin + "/" },
  };

  const html = sessionHtml(s, { agendaPath, when, descHtml, speakerSlugs, sponsorSlugs, speakersBase, sponsorsBase, env });
  const seen = {};
  const setMeta = (key, value) => ({ element(el) { seen[key] = true; el.setAttribute("content", value); } });
  const rw = new HTMLRewriter()
    .on("title", { element(el) { seen.title = true; el.setInnerContent(title); } })
    .on('meta[name="description"]', setMeta("description", description))
    .on('meta[property="og:title"]', setMeta("ogTitle", title))
    .on('meta[property="og:description"]', setMeta("ogDescription", description))
    .on('meta[property="og:url"]', setMeta("ogUrl", canonical))
    .on('meta[name="twitter:title"]', setMeta("twTitle", title))
    .on('meta[name="twitter:description"]', setMeta("twDescription", description))
    .on('link[rel="canonical"]', { element(el) { seen.canonical = true; el.setAttribute("href", canonical); } })
    .on('link[rel="shortlink"], link[rel="alternate"][type="application/json"]', { element(el) { el.remove(); } })
    .on("script.yoast-schema-graph, script.rank-math-schema, script.rank-math-schema-pro", { element(el) { el.remove(); } })
    .on("head", {
      element(el) {
        el.onEndTag((end) => {
          let extra = "";
          if (!seen.title) extra += `<title>${esc(title)}</title>`;
          if (!seen.description) extra += `<meta name="description" content="${esc(description)}">`;
          if (!seen.canonical) extra += `<link rel="canonical" href="${esc(canonical)}">`;
          if (!seen.ogTitle) extra += `<meta property="og:title" content="${esc(title)}">`;
          if (!seen.ogDescription) extra += `<meta property="og:description" content="${esc(description)}">`;
          if (!seen.ogUrl) extra += `<meta property="og:url" content="${esc(canonical)}">`;
          end.before(extra + ldScript(jsonLd), { html: true });
        });
      },
    })
    // The builder (its markup and script) lives inside #ai4-agenda-builder;
    // replacing its contents swaps the builder for the session details.
    .on("#ai4-agenda-builder", {
      element(el) {
        el.setAttribute("data-view", "session");
        el.setInnerContent(html, { html: true });
      },
    });

  const out = cleanHeaders(rw.transform(shell));
  out.headers.delete("link");
  return tag(out, "session");
}

function sessionHtml(s, { agendaPath, when, descHtml, speakerSlugs, sponsorSlugs, speakersBase, sponsorsBase, env }) {
  const p = [];
  p.push(`<div class="ai4-ss">`);
  p.push(`<nav class="ai4-ss-back"><a href="${esc(agendaPath)}">← Build your personalized agenda</a></nav>`);
  p.push(`<article>`);
  const kicker = [s.type, s.track].filter((x, i, a) => x && a.indexOf(x) === i).join(" · ");
  if (kicker) p.push(`<div class="ai4-ss-kicker">${esc(kicker)}</div>`);
  p.push(`<h1>${esc(s.title)}</h1>`);
  const meta = [when ? `<time datetime="${esc(isoWithOffset(s.beginsAt, env))}">${esc(when)}</time>` : "", s.place ? esc(s.place) : ""].filter(Boolean).join(" · ");
  if (meta) p.push(`<p class="ai4-ss-meta">${meta}</p>`);
  if (descHtml) p.push(`<section class="ai4-ss-desc"><h2>About this session</h2>${descHtml}</section>`);

  if (s.speakers && s.speakers.length) {
    p.push(`<section><h2>Speakers</h2><ul class="ai4-ss-people">`);
    for (const sp of s.speakers) {
      const slugP = speakerSlugs && speakerSlugs.get(sp.name.toLowerCase());
      const name = slugP ? `<a href="${esc(speakersBase + slugP + "/")}">${esc(sp.name)}</a>` : esc(sp.name);
      const sub = [sp.jobTitle, sp.organization].filter(Boolean).map(esc).join(", ");
      p.push(`<li><strong>${name}</strong>${sub ? `<span>${sub}</span>` : ""}</li>`);
    }
    p.push(`</ul></section>`);
  }
  if (s.exhibitors && s.exhibitors.length) {
    p.push(`<section><h2>${s.exhibitors.length === 1 ? "Sponsored by" : "Sponsors"}</h2><ul class="ai4-ss-people">`);
    for (const x of s.exhibitors) {
      const slugS = sponsorSlugs && sponsorSlugs.get(x.id);
      p.push(`<li><strong>${slugS ? `<a href="${esc(sponsorsBase + slugS + "/")}">${esc(x.name)}</a>` : esc(x.name)}</strong></li>`);
    }
    p.push(`</ul></section>`);
  }
  const tracks = [s.industry, s.function, s.ai_track, s.tech_track, s.special, s.keynote].filter(Boolean);
  if (tracks.length) p.push(`<section><h2>Tracks</h2><ul class="ai4-ss-pills">${[...new Set(tracks)].map((t) => `<li>${esc(t)}</li>`).join("")}</ul></section>`);
  p.push(`<p class="ai4-ss-cta"><a class="ai4-ss-btn" href="${esc(s.swapcard_url)}" target="_blank" rel="noopener">See details &amp; bookmark in the Ai4 app →</a></p>`);
  p.push(`</article></div>`);
  p.push(`<style>
    #ai4-agenda-builder[data-view="session"] .ai4-ss { max-width: 820px; margin: 0 auto; padding: 40px 24px 80px; color: var(--text-primary, #f0f0f8); font-family: var(--font-body, sans-serif); line-height: 1.6; }
    .ai4-ss a { color: var(--accent-orange, #ffbb7f); text-decoration: none; }
    .ai4-ss a:hover { text-decoration: underline; }
    .ai4-ss-back { margin: 0 0 28px; font-family: var(--font-display, sans-serif); font-weight: 600; font-size: 14px; }
    .ai4-ss-kicker { font-family: var(--font-display, sans-serif); font-size: 11px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--text-bright, #c8cbef); margin: 0 0 10px; }
    .ai4-ss h1 { font-family: var(--font-display, sans-serif); font-size: clamp(26px, 4.5vw, 38px); font-weight: 800; line-height: 1.2; margin: 0 0 12px; }
    .ai4-ss-meta { color: var(--text-secondary, #9396b0); margin: 0 0 28px; }
    .ai4-ss section { border-top: 1px solid var(--border, #1c2044); padding: 22px 0; }
    .ai4-ss h2 { font-family: var(--font-display, sans-serif); font-size: 16px; font-weight: 700; margin: 0 0 12px; color: var(--text-bright, #c8cbef); }
    .ai4-ss-desc p { margin: 0 0 12px; color: var(--text-primary, #f0f0f8); }
    .ai4-ss-people { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
    .ai4-ss-people span { display: block; color: var(--text-secondary, #9396b0); font-size: 14px; }
    .ai4-ss-pills { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
    .ai4-ss-pills li { border: 1px solid var(--accent-mid, #673fea50); background: var(--accent-dim, #673fea15); border-radius: 100px; padding: 4px 12px; font-size: 13px; }
    .ai4-ss-cta { border-top: 1px solid var(--border, #1c2044); padding-top: 24px; }
    .ai4-ss-btn { display: inline-block; background: var(--gradient, #673fea); color: #fff !important; font-family: var(--font-display, sans-serif); font-weight: 600; padding: 12px 22px; border-radius: 8px; }
  </style>`);
  return p.join("");
}

// ---------- links to speaker / sponsor pages (service bindings) ----------

async function getSpeakerSlugs(env) {
  return cachedLookup("speakers", env.SPEAKERS, "https://ai4-speakers.internal/speakers", (d) => {
    const map = new Map();
    for (const sp of d.speakers || []) if (sp.slug && sp.fullName) map.set(sp.fullName.trim().toLowerCase(), sp.slug);
    return map;
  });
}

async function getSponsorSlugs(env) {
  return cachedLookup("sponsors", env.SPONSORS, "https://ai4-sponsors.internal/sponsors", (d) => {
    const names = (d.fieldDefinitions || []).map((f) => f.name);
    const field = names.find((n) => /include.*public.*list/i.test(n)) || names.find((n) => /public.*list/i.test(n));
    const map = new Map();
    for (const s of d.sponsors || []) {
      if (!s.slug) continue;
      if (field) {
        const f = s.customFields && s.customFields[field];
        const vals = !f ? [] : f.type === "multiselect" ? f.values || [] : f.value ? [f.value] : [];
        if (!vals.some((v) => /^(yes|true|public)$/i.test(String(v).trim()))) continue;
      }
      map.set(s.id, s.slug);
    }
    return map;
  });
}

async function cachedLookup(key, binding, url, build) {
  if (!binding) return null;
  const memo = lookups[key];
  if (memo && Date.now() - memo.at < 10 * 60 * 1000) return memo.map;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const r = await binding.fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`${key} HTTP ${r.status}`);
    const map = build(await r.json());
    lookups[key] = { at: Date.now(), map };
    return map;
  } catch (err) {
    console.error(`[seo] ${key} lookup failed:`, err && err.message);
    return memo ? memo.map : null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- sitemap & markdown ----------

async function renderSitemap(request, env, ctx, data) {
  const loaded = await data.loadAgenda(env, ctx, { allowCold: true });
  if (!loaded) return null;
  const siteOrigin = siteOriginFor(request, env);
  const base = pathSetting(env.SESSIONS_PATH, "/sessions/");
  const lastmod = new Date(loaded.generatedAt || Date.now()).toISOString().slice(0, 10);
  const urls = [siteOrigin + pathSetting(env.AGENDA_PATH, "/agenda-builder/")]
    .concat(withSlugs(loaded.sessions).filter(hasPage).map((s) => siteOrigin + base + s.slug + "/"));
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url><loc>${esc(u)}</loc><lastmod>${lastmod}</lastmod></url>`).join("\n") + `\n</urlset>\n`;
  return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=1800", "X-Agenda-SSR": "sitemap" } });
}

async function renderMarkdown(request, env, ctx, data) {
  const loaded = await data.loadAgenda(env, ctx, { allowCold: true });
  if (!loaded) return null;
  const siteOrigin = siteOriginFor(request, env);
  const base = pathSetting(env.SESSIONS_PATH, "/sessions/");
  const sessions = sortByTime(withSlugs(loaded.sessions).slice());
  const out = [`# ${eventLabel(env)} agenda`, "", `${sessions.length} sessions. Times are Pacific (venue local). Updated ${loaded.generatedAt || ""}.`, `Build a personalized agenda: ${siteOrigin + pathSetting(env.AGENDA_PATH, "/agenda-builder/")}`, ""];
  let day = null;
  for (const s of sessions) {
    const d = dayLabel(s.beginsAt);
    if (d !== day) { day = d; out.push(`## ${d}`, ""); }
    out.push(`### ${timeLabel(s.beginsAt)}–${timeLabel(s.endsAt)} · ${s.title}`);
    const meta = [s.type, s.track, s.place].filter(Boolean).join(" · ");
    if (meta) out.push(meta);
    if (s.speakers && s.speakers.length) out.push(`Speakers: ${s.speakers.map((p) => [p.name, p.organization].filter(Boolean).join(" (") + (p.organization ? ")" : "")).join("; ")}`);
    if (s.exhibitors && s.exhibitors.length) out.push(`Sponsors: ${s.exhibitors.map((x) => x.name).join(", ")}`);
    out.push(hasPage(s) ? `Page: ${siteOrigin + base + s.slug}/` : `Details: ${s.swapcard_url}`);
    const d2 = plain(s.description);
    if (d2) out.push("", d2);
    out.push("");
  }
  return new Response(out.join("\n"), {
    headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=1800", "Link": `<${siteOrigin + pathSetting(env.AGENDA_PATH, "/agenda-builder/")}>; rel="canonical"`, "X-Agenda-SSR": "markdown" },
  });
}

// ---------- helpers ----------

function pathSetting(v, dflt) {
  let p = v || dflt;
  if (!p.startsWith("/")) p = "/" + p;
  if (!p.endsWith("/")) p += "/";
  return p;
}
function eventLabel(env) { return env.EVENT_LABEL || "Ai4"; }
function siteOriginFor(request, env) { return (env.SITE_ORIGIN || new URL(request.url).origin).replace(/\/$/, ""); }
function originFetch(request, env) {
  if (env.ORIGIN_OVERRIDE) {
    const u = new URL(request.url);
    const o = new URL(env.ORIGIN_OVERRIDE);
    u.protocol = o.protocol; u.host = o.host;
    return fetch(new Request(u.toString(), request));
  }
  return fetch(request);
}
function isHtml(res) { return (res.headers.get("content-type") || "").includes("text/html"); }
function cleanHeaders(res) {
  const out = new Response(res.body, res);
  out.headers.delete("etag"); out.headers.delete("last-modified"); out.headers.delete("content-length");
  return out;
}
function tag(res, value) {
  const out = new Response(res.body, res);
  out.headers.set("X-Agenda-SSR", value);
  return out;
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
function ldScript(obj) { return `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`; }
function plain(s) { return String(s || "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim(); }
function truncate(s, n) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), n - 20)).replace(/[\s,.;:]+$/, "") + "…";
}

// Swapcard times are venue-local without an offset ("2026-08-04 09:30:00").
function parts(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  return m ? { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] || 0) } : null;
}
function asUtc(iso) { const p = parts(iso); return p ? new Date(Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s)) : null; }
function sortByTime(list) { return list.sort((a, b) => String(a.beginsAt || "").localeCompare(String(b.beginsAt || "")) || a.title.localeCompare(b.title)); }
function dayKey(iso) { const p = parts(iso); return p ? `${p.y}-${p.mo}-${p.d}` : "tbd"; }
function dayLabel(iso) { const d = asUtc(iso); return d ? d.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" }) : ""; }
function timeLabel(iso) { const d = asUtc(iso); return d ? d.toLocaleTimeString("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit" }) : ""; }
function longWhen(b, e) { const day = dayLabel(b); if (!day) return ""; const t2 = timeLabel(e); return `${day}, ${timeLabel(b)}${t2 ? " – " + t2 : ""} PT`; }
function isoWithOffset(iso, env) {
  const p = parts(iso);
  if (!p) return "";
  const z = (n) => String(n).padStart(2, "0");
  return `${p.y}-${z(p.mo)}-${z(p.d)}T${z(p.h)}:${z(p.mi)}:${z(p.s)}${env.VENUE_UTC_OFFSET || "-07:00"}`;
}

// Allow-list sanitizer for Swapcard session descriptions (HTML).
async function sanitizeHtml(html) {
  const ALLOWED = new Set(["p", "br", "strong", "b", "em", "i", "ul", "ol", "li", "a"]);
  const DROP = new Set(["script", "style", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "base", "link", "meta", "noscript", "template", "svg", "math", "head", "title"]);
  const src = /<[a-z][\s\S]*>/i.test(html) ? String(html) : String(html).split(/\r\n|\r|\n{2,}/).map((x) => x.trim()).filter(Boolean).map((x) => `<p>${esc(x)}</p>`).join("");
  const rw = new HTMLRewriter()
    .on("*", {
      element(el) {
        const t = el.tagName.toLowerCase();
        if (DROP.has(t)) { el.remove(); return; }
        if (!ALLOWED.has(t)) { el.removeAndKeepContent(); return; }
        const href = t === "a" ? (el.getAttribute("href") || "").trim() : "";
        for (const [name] of [...el.attributes]) el.removeAttribute(name);
        if (t === "a") {
          if (/^https?:\/\//i.test(href)) { el.setAttribute("href", href); el.setAttribute("rel", "noopener nofollow"); el.setAttribute("target", "_blank"); }
          else el.removeAndKeepContent();
        }
      },
    })
    .onDocument({ comments(c) { c.remove(); } });
  return rw.transform(new Response(src, { headers: { "content-type": "text/html" } })).text();
}
