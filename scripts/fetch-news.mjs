// GitHub Actions에서 실행: JTBC 주요뉴스를 서버 쪽에서 가져와 news.json 으로 저장합니다.
// (서버에서 가져오므로 브라우저 CORS 제한이 없습니다. Node 20+, 외부 패키지 불필요)
import { readFile, writeFile } from "node:fs/promises";

const OUT = process.env.OUT || "news.json";
const COUNT = 30;
const MAX_AGE_DAYS = 7;
const GOOGLE_ART = /https:\/\/news\.google\.com\/(?:rss\/)?articles\/[^\s"'<>\]]+/i;

const SOURCES = [
  { name: "JTBC 이슈피드", own: true, url: "https://news-ex.jtbc.co.kr/v1/get/rss/issue" },
  { name: "구글뉴스(JTBC)", own: false,
    url: "https://news.google.com/rss/search?q=" + encodeURIComponent("site:news.jtbc.co.kr when:2d") +
         "&hl=ko&gl=KR&ceid=KR:ko" },
  { name: "JTBC 속보피드", own: true, url: "https://fs.jtbc.co.kr/RSS/newsflash.xml" },
];

async function getText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 (news-bot)" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const buf = await r.arrayBuffer();
    let txt = new TextDecoder("utf-8").decode(buf);
    const m = txt.slice(0, 200).match(/encoding=["']([\w-]+)/i);
    if (m && !/utf-?8/i.test(m[1])) { try { txt = new TextDecoder(m[1]).decode(buf); } catch {} }
    return txt;
  } finally { clearTimeout(t); }
}

const decode = s => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

function parseItems(text) {
  const blobs = text.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  return blobs.map(raw => {
    const b = raw.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&");
    const tm = b.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const dm = b.match(/<(?:pubDate|dc:date|published|updated)[^>]*>([^<]+)</i);
    return {
      title: decode((tm ? tm[1] : "").replace(/<[^>]+>/g, "")).trim(),
      blob: b,
      date: parseDate(dm && dm[1].trim()),
    };
  }).filter(i => i.title);
}

function resolveArticle(own, blob) {
  if (!own) { const m = blob.match(GOOGLE_ART); return m ? m[0] : null; }
  const m = blob.match(/news\.jtbc\.co\.kr\/article\/(NB\d+)/i) || blob.match(/news_id=(NB\d+)/i);
  return m ? "https://news.jtbc.co.kr/article/" + m[1] : null;
}

async function load(src) {
  let items = parseItems(await getText(src.url));
  if (!items.length) throw new Error("항목 없음");
  if (items.some(i => i.date)) {
    const newest = items.reduce((m, i) => (i.date && (!m || i.date > m) ? i.date : m), null);
    const cutoff = Date.now() - MAX_AGE_DAYS * 864e5;
    items = items.filter(i => i.date && i.date.getTime() >= cutoff).sort((a, b) => b.date - a.date);
    if (!items.length) throw new Error("최신 기사 없음 (가장 최근 " + newest.toISOString() + ")");
  }
  const results = items.slice(0, COUNT).map(i => ({
    title: src.own ? i.title : i.title.replace(/\s+-\s+[^-]+$/, ""),
    link: resolveArticle(src.own, i.blob),
    date: i.date ? i.date.toISOString() : null,
  }));
  const good = results.filter(r => r.link).length;
  if (!good || good < results.length / 2) throw new Error(`기사 주소 확인 ${good}/${results.length}`);
  return results.filter(r => r.link);
}

let picked = null;
for (const src of SOURCES) {
  try {
    const items = await load(src);
    picked = { source: src.name, items };
    console.log(`OK: ${src.name} (${items.length}건)`);
    break;
  } catch (e) {
    console.log(`실패: ${src.name} - ${e.message}`);
  }
}

if (!picked) {
  console.log("모든 출처 실패 - 기존 news.json 유지");
  process.exit(0);
}

let prev = null;
try { prev = JSON.parse(await readFile(OUT, "utf8")); } catch {}
const sig = o => JSON.stringify((o?.items || []).map(i => [i.title, i.link]));
if (prev && sig(prev) === sig(picked)) {
  console.log("변경 없음");
} else {
  await writeFile(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), ...picked }, null, 1) + "\n");
  console.log("news.json 갱신");
}
