// Builds events.json for the ExpatWay app.
//
// Runs on GitHub's runners, NOT on a phone — which is the whole point. Both
// sources refuse a plain mobile fetch: visitsaudi.com renders its list only in
// JavaScript, and eyeofriyadh.com answers 403 to anything without a browser
// user-agent. From here we can send a real UA and, for visitsaudi, hit the JSON
// endpoint its own front end calls.
//
// ⭐ IF A SCRAPE YIELDS ZERO ROWS THIS SCRIPT EXITS NON-ZERO AND COMMITS
// NOTHING. A broken selector must never publish an empty feed over a good one:
// the app would show every user an empty screen with no way to tell why. A
// failed run leaves the previous events.json live and the app keeps working on
// its 30-day cache.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const get = async (url, headers = {}) => {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', ...headers },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
};

const decode = (s = '') =>
  s.replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();

const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48);

// ── Classification ───────────────────────────────────────────────────────────
// Keyword-based because neither source publishes a category we can use. Add to
// these as you spot events landing in the wrong bucket — an unmatched event
// simply gets no industry, which is better than a wrong one.
//
// ⚠️ Keys MUST match EVENT_INDUSTRIES in the app's src/constants/ksaEvents.js.
const INDUSTRY_KEYWORDS = {
  it: ['leap', 'tech', 'digital', 'software', 'ai ', 'artificial intelligence', 'cyber',
    'data', 'cloud', 'telecom', 'gaming', 'gitex', 'fintech', 'blockchain', 'iot'],
  engineering: ['engineering', 'engineer', 'manufactur', 'industrial', 'automation',
    'machinery', 'welding', 'plant', 'maintenance'],
  construction: ['construction', 'build', 'infrastructure', 'real estate', 'cityscape',
    'architect', 'interior', 'concrete', 'hvac', 'project management'],
  medical: ['health', 'medical', 'pharma', 'dental', 'hospital', 'clinic', 'care',
    'medlab', 'nursing', 'biotech'],
  energy: ['energy', 'oil', 'gas', 'petro', 'solar', 'renewable', 'power', 'utilities',
    'hydrogen', 'water'],
  finance: ['finance', 'financial', 'bank', 'invest', 'capital', 'insurance', 'fintech',
    'trading', 'wealth'],
  logistics: ['logistic', 'supply chain', 'transport', 'shipping', 'freight', 'maritime',
    'aviation', 'ports', 'warehous'],
  education: ['education', 'school', 'university', 'training', 'learning', 'academic',
    'careers', 'recruitment'],
};

// ⚠️ Keys MUST match EVENT_TYPES in src/constants/ksaEvents.js.
const TYPE_KEYWORDS = {
  exhibition: ['exhibition', 'expo', 'show', 'fair', 'trade'],
  conference: ['conference', 'summit', 'forum', 'congress', 'symposium'],
  festival: ['festival', 'season', 'carnival'],
  concert: ['concert', 'live', 'tour', 'music'],
  sports: ['championship', 'grand prix', 'cup', 'marathon', 'race', 'tournament'],
};

const classify = (map, text, multi = false) => {
  const t = text.toLowerCase();
  const hits = Object.entries(map)
    .filter(([, words]) => words.some((w) => t.includes(w)))
    .map(([k]) => k);
  return multi ? hits : (hits[0] || null);
};

const CITIES = ['Riyadh', 'Jeddah', 'Dammam', 'Khobar', 'Makkah', 'Madinah',
  'Mecca', 'Medina', 'Abha', 'Taif', 'Tabuk', 'AlUla', 'Neom'];
const findCity = (text) =>
  CITIES.find((c) => text.toLowerCase().includes(c.toLowerCase())) || '';

// ⚠️ Built from LOCAL components, never `toISOString()`.
// `new Date('12 March 2027')` is local midnight; `.toISOString()` then converts
// to UTC and hands back 2027-03-11 for any timezone east of Greenwich. The
// runner happens to be UTC today, but that is not something to depend on — and
// this is the same class of bug the app's deeds log already had to fix.
const iso = (d) => {
  const t = new Date(d);
  if (isNaN(t)) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
};

// ── Source 1: Eye of Riyadh ──────────────────────────────────────────────────
// Server-rendered HTML, so a regex pass over the card markup works. It 403s a
// non-browser UA, which is exactly why this runs here and not in the app.
//
// ⚠️ SELECTOR — this is the part that will break first when the site is
// redesigned. If the run fails with "no events", start by dumping `html` and
// re-deriving this pattern.
async function eyeOfRiyadh() {
  const html = await get('https://www.eyeofriyadh.com/events/');
  const out = [];

  const cards = html.split(/<div[^>]+class="[^"]*event[-_]?(?:box|card|item)[^"]*"/i).slice(1);
  for (const raw of cards) {
    const block = raw.slice(0, 4000);
    const href = (block.match(/href="([^"]*\/events\/[^"]+)"/i) || [])[1];
    const title = decode((block.match(/<h[234][^>]*>([\s\S]*?)<\/h[234]>/i) || [])[1] || '');
    const dateText = decode((block.match(/(\d{1,2}\s+\w+\s+\d{4}[^<]{0,40})/) || [])[1] || '');
    if (!title || !dateText) continue;

    const parts = dateText.match(/\d{1,2}\s+\w+\s+\d{4}/g) || [];
    const start = iso(parts[0]);
    if (!start) continue;
    const end = parts[1] ? iso(parts[1]) : start;

    const venue = decode((block.match(/venue[^>]*>([^<]{3,80})</i) || [])[1] || '');
    const context = `${title} ${venue} ${block.slice(0, 600)}`;

    out.push({
      key: `eor_${slug(title)}_${start}`,
      source: 'eyeofriyadh',
      title,
      organizer: '',
      city: findCity(context),
      venue,
      start,
      end,
      type: classify(TYPE_KEYWORDS, title) || 'exhibition',
      industry: classify(INDUSTRY_KEYWORDS, context, true),
      category: 'business',
      tier: 2,
      desc: '',
      plan: '',
      url: href
        ? (href.startsWith('http') ? href : `https://www.eyeofriyadh.com${href}`)
        : 'https://www.eyeofriyadh.com/events/',
      icon: 'calendar-star',
      color: '#0EA5E9',
    });
  }
  return out;
}

// ── Source 2: Visit Saudi ────────────────────────────────────────────────────
// The page itself is a JS shell with no event data in its HTML. Its front end
// calls a search API, which is what we hit instead. If this endpoint moves, the
// fallback is to drop this source — Eye of Riyadh alone still fills the feed,
// which is why a failure here warns rather than throws.
async function visitSaudi() {
  const url = 'https://www.visitsaudi.com/bin/vs/search?types=events&locale=en&limit=100';
  let json;
  try {
    json = JSON.parse(await get(url, { Accept: 'application/json' }));
  } catch (e) {
    console.warn(`visitsaudi: ${e.message} - continuing without it`);
    return [];
  }

  const rows = json?.results || json?.items || json?.data || [];
  return rows.map((r) => {
    const title = decode(r.title || r.name || '');
    const start = iso(r.startDate || r.start);
    if (!title || !start) return null;
    const context = `${title} ${r.description || ''} ${r.location || ''}`;
    return {
      key: `vs_${slug(title)}_${start}`,
      source: 'visitsaudi',
      title,
      organizer: 'Visit Saudi',
      city: findCity(context) || decode(r.city || r.location || ''),
      venue: decode(r.venue || ''),
      start,
      end: iso(r.endDate || r.end) || start,
      type: classify(TYPE_KEYWORDS, title) || 'festival',
      industry: classify(INDUSTRY_KEYWORDS, context, true),
      category: 'culture',
      tier: 2,
      desc: decode(r.description || '').slice(0, 240),
      plan: '',
      url: String(r.url || '').startsWith('http') ? r.url : 'https://www.visitsaudi.com/en/saudi-calendar',
      icon: 'ferris-wheel',
      color: '#DB2777',
    };
  }).filter(Boolean);
}

// ── Build ────────────────────────────────────────────────────────────────────
// allSettled, not all: one source dying must not take the other down with it.
const settled = await Promise.allSettled([eyeOfRiyadh(), visitSaudi()]);
settled.forEach((r, i) => {
  if (r.status === 'rejected') console.warn(`source ${i} failed: ${r.reason?.message}`);
});

const today = iso(new Date());
const seen = new Set();
const events = settled
  .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
  // Drop anything already over — the app would filter it out anyway, and the
  // file stays small.
  .filter((e) => (e.end || e.start) >= today)
  .filter((e) => (seen.has(e.key) ? false : seen.add(e.key)))
  .sort((a, b) => a.start.localeCompare(b.start))
  .slice(0, 300);

// ⭐ The guard. Never overwrite a good feed with an empty one.
if (!events.length) {
  console.error('No events scraped from any source - refusing to write an empty feed.');
  console.error('A selector has probably changed. Dump the HTML and re-derive it.');
  process.exit(1);
}

// A collapse to a fraction of the previous size is the same failure in slow
// motion — one source silently dying. Fail rather than quietly halve the feed.
if (existsSync('events.json')) {
  try {
    const prev = JSON.parse(readFileSync('events.json', 'utf8'));
    const prevCount = prev?.events?.length || 0;
    if (prevCount > 20 && events.length < prevCount * 0.4) {
      console.error(`Only ${events.length} events vs ${prevCount} last time - refusing to publish.`);
      process.exit(1);
    }
  } catch { /* an unreadable previous file is not a reason to fail */ }
}

writeFileSync('events.json', JSON.stringify({ generated: today, events }, null, 2) + '\n');
console.log(`Wrote ${events.length} events.`);
