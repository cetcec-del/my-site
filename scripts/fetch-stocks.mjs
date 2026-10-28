// GitHub Actions에서 실행: 코스피/코스닥 등락률을 서버 쪽에서 가져와 stocks.json 으로 저장합니다.
// (서버에서 가져오므로 브라우저 CORS 제한이 없습니다. Node 20+, 외부 패키지 불필요)
import { readFile, writeFile } from "node:fs/promises";

const OUT = process.env.OUT || "stocks.json";
const UA = { "User-Agent": "Mozilla/5.0 (stock-bot)", "Accept": "application/json" };

async function getJSON(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: UA });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

const num = v => parseFloat(String(v).replace(/,/g, ""));
function ok(v) {
  if (!Number.isFinite(v) || Math.abs(v) > 30) throw new Error("비정상 값: " + v);
  return Math.round(v * 100) / 100;
}

// 1순위: 네이버 증권 실시간 폴링 (키 불필요) - 응답의 datas[0]에 지수 정보가 들어 있음
async function naverPolling(code) {
  const j = await getJSON(`https://polling.finance.naver.com/api/realtime/domestic/index/${code}`);
  const d = (j.datas && j.datas[0]) || j;
  let v = num(d.fluctuationsRatio);
  const diff = num(d.compareToPreviousClosePrice);
  const dir = d.compareToPreviousPrice && String(d.compareToPreviousPrice.code);
  if (Number.isFinite(v) && v > 0 && ((diff < 0) || dir === "4" || dir === "5")) v = -v;   // 하락이면 음수로
  if (!Number.isFinite(v)) {
    const close = num(d.closePrice);
    v = diff / (close - diff) * 100;
  }
  return ok(v);
}

// 2순위: 네이버 모바일 증권 (증시는 네이버 증권에서만 가져옵니다)
async function naver(code) {
  const j = await getJSON(`https://m.stock.naver.com/api/index/${code}/basic`);
  let v = num(j.fluctuationsRatio);
  const dir = j.compareToPreviousPrice && String(j.compareToPreviousPrice.code);
  if (Number.isFinite(v) && (dir === "4" || dir === "5") && v > 0) v = -v;   // 하락/하한
  if (!Number.isFinite(v)) {                                                  // 비율이 없으면 직접 계산
    const close = num(j.closePrice), diff = num(j.compareToPreviousClosePrice);
    v = diff / (close - diff) * 100;
  }
  return ok(v);
}

async function rate(name, nCode) {
  const errs = [];
  for (const [src, fn] of [["naver-polling", () => naverPolling(nCode)], ["naver", () => naver(nCode)]]) {
    try { const v = await fn(); console.log(`OK ${name}: ${v}% (${src})`); return { v, src }; }
    catch (e) { errs.push(`${src}: ${e.message}`); }
  }
  console.log(`실패 ${name} - ${errs.join(" / ")}`);
  return null;
}

const [k, q] = await Promise.all([rate("코스피", "KOSPI"), rate("코스닥", "KOSDAQ")]);

let prev = {};
try { prev = JSON.parse(await readFile(OUT, "utf8")); } catch {}

if (!k && !q) { console.log("모두 실패 - 기존 stocks.json 유지"); process.exit(0); }

// 한쪽만 실패하면 직전 값 유지
const out = {
  updatedAt: new Date().toISOString(),
  kospi: k ? k.v : prev.kospi ?? null,
  kosdaq: q ? q.v : prev.kosdaq ?? null,
  source: { kospi: k ? k.src : prev.source?.kospi ?? null, kosdaq: q ? q.src : prev.source?.kosdaq ?? null },
};
await writeFile(OUT, JSON.stringify(out, null, 1) + "\n");
console.log("stocks.json 갱신");
