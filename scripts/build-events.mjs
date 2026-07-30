// Builds events.json for the ExpatWay app.
//
// Runs on GitHub's runners, NOT on a phone — which is the whole point.
// eyeofriyadh.com answers 403 to anything without a browser user-agent, so the
// app can never read it directly. From here we can send a real UA.
//
// ⭐ IF A SCRAPE YIELDS ZERO ROWS THIS SCRIPT EXITS NON-ZERO AND COMMITS
// NOTHING. A broken selector must never publish an empty feed over a good one:
// the app would show every user an empty screen with no way to tell why. A
// failed run leaves the previous events.json live and the app keeps working on
// its 30-day cache.
//
// ⛔ VISIT SAUDI IS DELIBERATELY NOT A SOURCE.
// visitsaudi.com renders its calendar entirely in JavaScript — the HTML holds
// no event data at all — and it exposes no JSON endpoint: /api/events,
// /bin/vs/*, .model.json and even /sitemap.xml all return 404. Reading it would
// need a headless browser (Playwright) in this workflow. It is not worth that:
// the seasons and festivals it would add are already in the app's curated
// ksaEvents.js, and they are recurrence rules rather than published dates, so
// they do not go stale. Do not re-add it without checking those URLs again.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36';

// The listing is paginated at a FIXED 16 per page — `ipp` in the URL is ignored,
// tested at 50/100/200. Events come soonest-first, so the early pages are the
// ones worth having. 12 pages ≈ 190 events and keeps the run polite.
const PAGES = 12;
const PAGE_URL = (p) => `https://www.eyeofriyadh.com/events/index.php?&page=${p}&ipp=10`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const get = async (url) => {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
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

// ── Dates ────────────────────────────────────────────────────────────────────
// ⚠️ Built from LOCAL components, never `toISOString()`. `new Date(...)` then
// `.toISOString()` converts to UTC and hands back the previous day for any
// timezone east of Greenwich. The runner happens to be UTC, but that is not
// something to depend on.
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const p2 = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${p2(m + 1)}-${p2(d)}`;
const todayISO = () => {
  const t = new Date();
  return ymd(t.getFullYear(), t.getMonth(), t.getDate());
};

// Eye of Riyadh writes one of three shapes, always with a single trailing year:
//   "26 Jan, 2027"           single day
//   "25 - 27 Jan, 2027"      range inside one month
//   "5 Aug - 22 Sep, 2026"   range across months
// The year belongs to the END date, so a Dec->Jan range starts the year before.
function parseRange(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  const year = Number((t.match(/(\d{4})\s*$/) || [])[1]);
  if (!year) return null;

  let m = t.match(/^(\d{1,2})\s*[-–]\s*(\d{1,2})\s+([A-Za-z]{3})/);
  if (m) {
    const mo = MONTHS[m[3].toLowerCase()];
    if (mo == null) return null;
    return { start: ymd(year, mo, +m[1]), end: ymd(year, mo, +m[2]) };
  }

  m = t.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s*[-–]\s*(\d{1,2})\s+([A-Za-z]{3})/);
  if (m) {
    const mo1 = MONTHS[m[2].toLowerCase()];
    const mo2 = MONTHS[m[4].toLowerCase()];
    if (mo1 == null || mo2 == null) return null;
    return { start: ymd(mo1 > mo2 ? year - 1 : year, mo1, +m[1]), end: ymd(year, mo2, +m[3]) };
  }

  m = t.match(/^(\d{1,2})\s+([A-Za-z]{3})/);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (mo == null) return null;
    return { start: ymd(year, mo, +m[1]), end: ymd(year, mo, +m[1]) };
  }
  return null;
}

// ── Classification ───────────────────────────────────────────────────────────
// ⚠️ Keys MUST match EVENT_TYPES in the app's src/constants/ksaEvents.js.
// The site publishes its own type (Exhibition, Conference, Forum, Summit, Award,
// Championship, "Professional Development Programme"…), which is far better than
// guessing from the title — so this maps that vocabulary onto ours.
function mapType(siteType, title) {
  const t = `${siteType} ${title}`.toLowerCase();
  if (/exhibition|expo|trade\s*show|fair/.test(t)) return 'exhibition';
  if (/championship|cup|marathon|race|tournament|sport/.test(t)) return 'sports';
  if (/festival|season|carnival/.test(t)) return 'festival';
  if (/concert|music|live\s*show/.test(t)) return 'concert';
  if (/conference|forum|summit|congress|seminar|award|programme|program|workshop|training/.test(t)) return 'conference';
  return 'exhibition'; // it is an exhibitions listing; this is the safe default
}

// ⭐ The filter the app is actually for — an IT professional wants LEAP, an
// engineer wants the construction show. Keyword-based because the site's own
// categories are too coarse. Add to these as you spot events in the wrong
// bucket; an unmatched event simply gets no industry, which is better than a
// wrong one.
// ⚠️ Keys MUST match EVENT_INDUSTRIES in src/constants/ksaEvents.js.
const INDUSTRY_KEYWORDS = {
  it: ['leap', 'deepfest', 'tech', 'digital', 'software', ' ai ', 'artificial intelligence', 'cyber',
    'data', 'cloud', 'telecom', 'gaming', 'esports', 'fintech', 'blockchain', 'iot', 'proptech',
    'innovation', 'electronics'],
  engineering: ['engineering', 'engineer', 'manufactur', 'industrial', 'automation', 'machinery',
    'welding', 'plant', 'maintenance', 'metal', 'plastic', 'printing', 'packaging'],
  construction: ['construction', 'construct', 'build', 'infrastructure', 'real estate', 'cityscape',
    'architect', 'interior', 'concrete', 'hvac', 'facilities', 'fm ', 'wood', 'stone', 'ceramic',
    'lighting', 'glass'],
  medical: ['health', 'medical', 'pharma', 'dental', 'hospital', 'clinic', 'medlab', 'nursing',
    'biotech', 'laboratory', 'beauty', 'cosmetic'],
  energy: ['energy', 'oil', 'gas', 'petro', 'solar', 'renewable', 'power', 'utilities', 'hydrogen',
    'water', 'offshore', 'mining'],
  finance: ['finance', 'financial', 'bank', 'invest', 'capital', 'insurance', 'trading', 'wealth',
    'accounting', 'tax'],
  logistics: ['logistic', 'supply chain', 'transport', 'shipping', 'freight', 'maritime', 'aviation',
    'ports', 'warehous', 'procurement', 'rail'],
  education: ['education', 'school', 'university', 'training', 'learning', 'academic', 'careers',
    'recruitment', 'hr ', 'human resource', 'talent'],
};

const classifyIndustry = (text) => {
  const t = ` ${text.toLowerCase()} `;
  return Object.entries(INDUSTRY_KEYWORDS)
    .filter(([, words]) => words.some((w) => t.includes(w)))
    .map(([k]) => k);
};

// ── Source: Eye of Riyadh ────────────────────────────────────────────────────
// ⚠️ SELECTORS — this is what breaks first when the site is redesigned. The
// markup has NO semantic classes; every card is inline-styled divs, so these
// patterns key off those inline styles. If a run fails with "no events", fetch
// a page with the UA above, save the HTML, and re-derive from it. The shape as
// of July 2026:
//
//   <div style="margin-bottom:25px; ...">                        ← card wrapper
//     <a href="/events/details/SLUG"><img ...></a>
//     <div style="color:#666A73; padding:0px 10px 3px 10px;">30 Aug - 2 Sep, 2026</div>
//     <div ...><a href="details/SLUG" style="...font-weight:700...">TITLE</a></div>
//     <div style="color:#ADB0B6;...">VENUE , CITY | <a href="?fcat=N">TYPE</a></div>
//     <div style="color:#666A73; margin-bottom:10px;">DESCRIPTION</div>
//   </div>
function parsePage(html) {
  const flat = html.replace(/\n/g, ' ');
  const cards = flat.split(/<div style="margin-bottom:25px/i).slice(1);
  const out = [];

  for (const block of cards) {
    const titleM = block.match(/<a href="[^"]*details\/([^"]+)"[^>]*font-weight:700[^>]*>([\s\S]*?)<\/a>/);
    if (!titleM) continue;
    const urlSlug = titleM[1];
    const title = decode(titleM[2]);

    const dateM = block.match(/<div style="color:#666A73;\s*padding:0px 10px 3px 10px;">([^<]+)<\/div>/);
    const range = dateM ? parseRange(decode(dateM[1])) : null;
    if (!title || !range) continue;

    // "Venue , City | <a>Type</a>"
    const locRaw = (block.match(/<div style="color:#ADB0B6;[^"]*">([\s\S]*?)<\/div>/) || [])[1] || '';
    const siteType = decode((locRaw.match(/fcat=\d+"[^>]*>([^<]+)<\/a>/) || [])[1] || '');
    const place = decode(locRaw.replace(/<a[\s\S]*$/, '')).replace(/\|\s*$/, '').trim();
    const bits = place.split(',').map((x) => x.trim()).filter(Boolean);
    const city = bits.length > 1 ? bits[bits.length - 1] : '';
    const venue = bits.length > 1 ? bits.slice(0, -1).join(', ') : place;

    const desc = decode((block.match(/<div style="color:#666A73;\s*margin-bottom:10px;">([\s\S]*?)<\/div>/) || [])[1] || '');

    out.push({
      key: `eor_${urlSlug}_${range.start}`,
      source: 'eyeofriyadh',
      title,
      organizer: '',
      city,
      venue,
      start: range.start,
      end: range.end,
      type: mapType(siteType, title),
      // Classified on clean text, not raw HTML — style attributes and venue
      // names were adding false matches.
      industry: classifyIndustry(`${title} ${desc} ${siteType}`),
      category: 'business',
      tier: 2,
      desc: desc.slice(0, 240),
      plan: '',
      url: `https://www.eyeofriyadh.com/events/details/${urlSlug}`,
      icon: 'calendar-star',
      color: '#0EA5E9',
    });
  }
  return out;
}

async function eyeOfRiyadh() {
  const all = [];
  for (let p = 1; p <= PAGES; p++) {
    try {
      const rows = parsePage(await get(PAGE_URL(p)));
      console.log(`page ${p}: ${rows.length} events`);
      // A page yielding nothing means we ran past the end, or the markup moved.
      // Either way there is no point hammering the remaining pages.
      if (!rows.length) break;
      all.push(...rows);
    } catch (e) {
      console.warn(`page ${p} failed: ${e.message}`);
    }
    await sleep(400); // be polite
  }
  return all;
}

// ── Build ────────────────────────────────────────────────────────────────────
const scraped = await eyeOfRiyadh();

const today = todayISO();
const seen = new Set();
const events = scraped
  // Drop anything already finished — the app filters it out anyway and the file
  // stays small.
  .filter((e) => (e.end || e.start) >= today)
  .filter((e) => (seen.has(e.key) ? false : seen.add(e.key)))
  .sort((a, b) => a.start.localeCompare(b.start))
  .slice(0, 300);

// ⭐ The guard. Never overwrite a good feed with an empty one.
if (!events.length) {
  console.error('No events scraped - refusing to write an empty feed.');
  console.error('A selector has probably changed. Fetch a page with the UA in this file,');
  console.error('save the HTML, and re-derive the patterns in parsePage().');
  process.exit(1);
}

// A collapse to a fraction of the previous size is the same failure in slow
// motion — the markup half-changed. Fail rather than quietly gut the feed.
if (existsSync('events.json')) {
  try {
    const prevCount = JSON.parse(readFileSync('events.json', 'utf8'))?.events?.length || 0;
    if (prevCount > 20 && events.length < prevCount * 0.4) {
      console.error(`Only ${events.length} events vs ${prevCount} last time - refusing to publish.`);
      process.exit(1);
    }
  } catch { /* an unreadable previous file is not a reason to fail */ }
}

writeFileSync('events.json', JSON.stringify({ generated: today, events }, null, 2) + '\n');
console.log(`\nWrote ${events.length} events.`);
const byIndustry = {};
for (const e of events) for (const i of e.industry) byIndustry[i] = (byIndustry[i] || 0) + 1;
console.log('By field:', JSON.stringify(byIndustry));
