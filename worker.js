// ══════════════════════════════════════════════════════════════
//  Ai4 2026 — Cloudflare Worker v3
//  Swapcard API integration + Anthropic Claude proxy
// ══════════════════════════════════════════════════════════════
//
//  ENDPOINTS:
//    POST /            → Proxies requests to Anthropic Claude API
//    GET  /sessions    → Returns all sessions from Swapcard (cached 1hr)
//    GET  /health      → Health check
//
//  ENVIRONMENT VARIABLES (set in Workers Settings → Variables & Secrets):
//    ANTHROPIC_API_KEY   → Your Anthropic API key (sk-ant-...)
//    SWAPCARD_API_KEY    → Your Swapcard API key
//
//  SETUP:
//    1. Replace your existing worker code with this file
//    2. Add SWAPCARD_API_KEY as a new encrypted environment variable
//    3. Deploy
//    4. Update your HTML page's data loader to fetch from /sessions
//
// ══════════════════════════════════════════════════════════════

// ── Configuration ──
const SWAPCARD_GRAPHQL_URL = 'https://developer.swapcard.com/graphql';
const COMMUNITY_ID = 'Q29tbXVuaXR5XzExODYw';
const EVENT_ID = 'RXZlbnRfMzgxNjMzOA==';

// Custom field definition IDs from Swapcard
const FIELD_IDS = {
  type: 'RmllbGREZWZpbml0aW9uXzMzMzYxMQ==',
  allTracks: 'RmllbGREZWZpbml0aW9uXzM0OTk5NA==',
  keynotesMeals: 'RmllbGREZWZpbml0aW9uXzY5NjI0MA==',
  industryTracks: 'RmllbGREZWZpbml0aW9uXzcxMjcwNA==',
  jobFunctionTracks: 'RmllbGREZWZpbml0aW9uXzcxMjcwNQ==',
  aiTransformationTracks: 'RmllbGREZWZpbml0aW9uXzgwNTY5Nw==',
  specialInterestTracks: 'RmllbGREZWZpbml0aW9uXzgwNTY5OA==',
  technicalTracks: 'RmllbGREZWZpbml0aW9uXzgwNTY5OQ==',
};

// Anthropic config
const PRIMARY_MODEL = 'claude-sonnet-4-5';
const FALLBACK_MODEL = 'claude-haiku-4-5';
const MAX_RETRIES = 3;

const CORS_ALLOWED_ORIGINS = [
  'https://ai4.io',
  'https://www.ai4.io',
  'http://localhost',
  'http://localhost:3000',
];

const SESSION_CACHE_TTL = 60 * 60; // 1 hour in seconds

// ══════════════════════════════════════════
//  SWAPCARD SESSION FETCHING
// ══════════════════════════════════════════

const SESSIONS_QUERY = `
query FetchSessions($communityId: ID!, $filter: EventPlanningFilterInput, $cursor: CursorPaginationInput, $sort: [PlanningSortType!]) {
  planningsV2(communityId: $communityId, filter: $filter, sort: $sort, cursor: $cursor) {
    pageInfo {
      endCursor
      hasNextPage
    }
    totalCount
    nodes {
      id
      title
      description
      beginsAt
      endsAt
      place
      type
      fields {
        __typename
        ... on SelectField {
          id
          value
          definition {
            id
            name
          }
        }
        ... on MultipleSelectField {
          id
          value
          definition {
            id
            name
          }
        }
        ... on TextField {
          id
          value
          definition {
            id
            name
          }
        }
      }
      speakers {
        id
        firstName
        lastName
        jobTitle
        organization
      }
    }
  }
}`;

async function fetchAllSessions(apiKey) {
  const allSessions = [];
  let hasNextPage = true;
  let cursor = null;
  let pageCount = 0;

  while (hasNextPage && pageCount < 20) { // Safety limit: 20 pages × 100 = 2000 sessions max
    const variables = {
      communityId: COMMUNITY_ID,
      filter: { eventIds: [EVENT_ID] },
      sort: [{ field: 'BEGINS_AT', order: 'ASC' }],
      cursor: {
        first: 100,
        ...(cursor ? { after: cursor } : {}),
      },
    };

    const response = await fetch(SWAPCARD_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiKey,
      },
      body: JSON.stringify({ query: SESSIONS_QUERY, variables }),
    });

    if (!response.ok) {
      throw new Error(`Swapcard API error: HTTP ${response.status}`);
    }

    const json = await response.json();

    if (json.errors) {
      throw new Error(`Swapcard GraphQL error: ${json.errors[0].message}`);
    }

    const data = json.data.planningsV2;
    const nodes = data.nodes || [];
    allSessions.push(...nodes);

    hasNextPage = data.pageInfo.hasNextPage;
    cursor = data.pageInfo.endCursor;
    pageCount++;
  }

  return allSessions;
}

function getFieldValue(fields, definitionId) {
  if (!fields) return null;
  for (const field of fields) {
    const defId = field.definition && field.definition.id;
    if (defId === definitionId && field.value) {
      return field.value;
    }
  }
  return null;
}

function formatDate(isoString) {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    const month = d.getMonth() + 1;
    const day = d.getDate();
    let hours = d.getHours();
    const mins = d.getMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    return `${month}/${day} ${hours}:${mins} ${ampm}`;
  } catch {
    return isoString;
  }
}

function slugToReadable(slug) {
  if (!slug) return '';
  return slug
    .replace(/^"|"$/g, '')
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
    .replace(/\band\b/gi, '&')
    .replace(/\bai\b/gi, 'AI')
    .replace(/\bml\b/gi, 'ML')
    .replace(/\brag\b/gi, 'RAG')
    .replace(/\broi\b/gi, 'ROI')
    .replace(/\bvcs\b/gi, 'VCs')
    .replace(/\bsmbs\b/gi, 'SMBs')
    .replace(/\bhrtech\b/gi, 'HRTech')
    .replace(/\bcaio\b/gi, 'CAIO')
    .replace(/\bcio\b/gi, 'CIO')
    .replace(/\bcfo\b/gi, 'CFO')
    .replace(/\bcx\b/gi, 'CX')
    .replace(/\bbi\b/gi, 'BI')
    .replace(/\baec\b/gi, 'AEC')
    .replace(/\bcpg\b/gi, 'CPG')
    .replace(/\biot\b/gi, 'IoT')
    .replace(/\bllms\b/gi, 'LLMs')
    .replace(/\bgans\b/gi, 'GANs')
    .replace(/\bslms\b/gi, 'SLMs')
    .replace(/\bgpus\b/gi, 'GPUs');
}

function transformSessions(rawSessions) {
  return rawSessions
    .filter(s => {
      // Skip private or non-content sessions
      if (!s.title || !s.beginsAt) return false;
      return true;
    })
    .map(s => {
      const fields = s.fields || [];
      const sessionType = getFieldValue(fields, FIELD_IDS.type);
      const allTracks = getFieldValue(fields, FIELD_IDS.allTracks);
      const keynote = getFieldValue(fields, FIELD_IDS.keynotesMeals);
      const industry = getFieldValue(fields, FIELD_IDS.industryTracks);
      const jobFunction = getFieldValue(fields, FIELD_IDS.jobFunctionTracks);
      const aiTransformation = getFieldValue(fields, FIELD_IDS.aiTransformationTracks);
      const specialInterest = getFieldValue(fields, FIELD_IDS.specialInterestTracks);
      const technical = getFieldValue(fields, FIELD_IDS.technicalTracks);

      // Build track display name from the most specific category
      const trackSlug = allTracks || keynote || industry || jobFunction || aiTransformation || specialInterest || technical || '';
      const track = slugToReadable(trackSlug);

      // Clean description
      const desc = (s.description || '')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]*>/g, '')
        .trim()
        .substring(0, 300);

      // Format speakers
      const speakers = (s.speakers || []).map(sp =>
        `${sp.firstName || ''} ${sp.lastName || ''}`.trim() +
        (sp.jobTitle && sp.organization ? ` (${sp.jobTitle}, ${sp.organization})` :
         sp.organization ? ` (${sp.organization})` :
         sp.jobTitle ? ` (${sp.jobTitle})` : '')
      );

      const session = {
        id: s.id,
        swapcard_url: `https://ai4.app.swapcard.com/event/ai4-2026/planning/${s.id}`,
        title: s.title,
        desc,
        start: formatDate(s.beginsAt),
        end: formatDate(s.endsAt),
        type: slugToReadable(sessionType),
        track,
        place: s.place || '',
      };

      // Only include non-empty categorization fields
      if (industry) session.industry = slugToReadable(industry);
      if (jobFunction) session.function = slugToReadable(jobFunction);
      if (aiTransformation) session.ai_track = slugToReadable(aiTransformation);
      if (technical) session.tech_track = slugToReadable(technical);
      if (specialInterest) session.special = slugToReadable(specialInterest);
      if (keynote) session.keynote = slugToReadable(keynote);
      if (speakers.length > 0) session.speakers = speakers;

      return session;
    });
}


// ══════════════════════════════════════════
//  ANTHROPIC API PROXY WITH RESILIENCE
// ══════════════════════════════════════════

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callAnthropic(body, apiKey) {
  return await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
}

async function callWithResilience(body, apiKey) {
  // Phase 1: Primary model with retries
  body.model = PRIMARY_MODEL;
  let lastResponse;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    lastResponse = await callAnthropic(body, apiKey);
    if (lastResponse.status !== 529 && lastResponse.status !== 503) {
      return lastResponse;
    }
    if (attempt < MAX_RETRIES - 1) {
      await sleep(1000 * Math.pow(2, attempt));
    }
  }

  // Phase 2: Fallback to Haiku
  console.log('Primary model overloaded, falling back to Haiku');
  body.model = FALLBACK_MODEL;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    lastResponse = await callAnthropic(body, apiKey);
    if (lastResponse.status !== 529 && lastResponse.status !== 503) {
      return lastResponse;
    }
    if (attempt < MAX_RETRIES - 1) {
      await sleep(1000 * Math.pow(2, attempt));
    }
  }

  return lastResponse;
}


// ══════════════════════════════════════════
//  CORS HELPERS
// ══════════════════════════════════════════

function getCorsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const isAllowed = CORS_ALLOWED_ORIGINS.some(o => origin.startsWith(o));
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : CORS_ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}


// ══════════════════════════════════════════
//  MAIN ROUTER
// ══════════════════════════════════════════

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = getCorsHeaders(request);

    // ── Preflight ──
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ── Route: GET /sessions ──
    if (url.pathname === '/sessions' && request.method === 'GET') {
      return handleGetSessions(request, env, ctx, corsHeaders);
    }

    // ── Route: GET /health ──
    if (url.pathname === '/health' && request.method === 'GET') {
      return new Response(JSON.stringify({
        status: 'ok',
        endpoints: ['POST / (Claude proxy)', 'GET /sessions (Swapcard data)', 'GET /health'],
        eventId: EVENT_ID,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Route: POST / (Anthropic proxy) ──
    if (request.method === 'POST') {
      return handleAnthropicProxy(request, env, corsHeaders);
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  },
};


// ── Handler: GET /sessions ──
async function handleGetSessions(request, env, ctx, corsHeaders) {
  const cacheKey = new Request(new URL('/sessions', request.url).toString(), { method: 'GET' });
  const cache = caches.default;

  // Check Cloudflare cache
  let cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    // Clone and add CORS headers (cached response may not have them for this origin)
    const body = await cachedResponse.text();
    return new Response(body, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'X-Cache': 'HIT',
      },
    });
  }

  // Fetch fresh from Swapcard
  try {
    if (!env.SWAPCARD_API_KEY) {
      throw new Error('SWAPCARD_API_KEY environment variable is not set');
    }

    const rawSessions = await fetchAllSessions(env.SWAPCARD_API_KEY);
    const sessions = transformSessions(rawSessions);

    const responseBody = JSON.stringify({
      sessions,
      count: sessions.length,
      source: 'swapcard',
      fetchedAt: new Date().toISOString(),
    });

    const response = new Response(responseBody, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${SESSION_CACHE_TTL}`,
        'X-Cache': 'MISS',
      },
    });

    // Store in Cloudflare edge cache (background, doesn't block response)
    ctx.waitUntil(cache.put(cacheKey, new Response(responseBody, {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${SESSION_CACHE_TTL}`,
      },
    })));

    return response;

  } catch (err) {
    return new Response(JSON.stringify({
      error: 'Failed to fetch sessions from Swapcard',
      message: err.message,
    }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}


// ── Handler: POST / (Anthropic proxy) ──
async function handleAnthropicProxy(request, env, corsHeaders) {
  try {
    const body = await request.json();

    if (!body.messages || !body.model) {
      return new Response(JSON.stringify({ error: 'Invalid request format' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    body.max_tokens = Math.min(body.max_tokens || 8000, 8000);

    const anthropicResponse = await callWithResilience(body, env.ANTHROPIC_API_KEY);
    const result = await anthropicResponse.text();

    return new Response(result, {
      status: anthropicResponse.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: 'Proxy error: ' + err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}
