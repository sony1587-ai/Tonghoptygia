// ============================================================================
// scraper/index.js — TOÀN BỘ logic cào tỷ giá 9 ngân hàng + ghi Firebase.
// Chạy bởi GitHub Actions (3 lần/ngày) hoặc thủ công (npm run scrape).
// ============================================================================

const admin = require("firebase-admin");
const xml2js = require("xml2js");
const puppeteer = require("puppeteer");

const WANTED = ["USD", "EUR", "JPY", "THB", "GBP", "AUD"];

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label}: quá thời gian chờ (${ms / 1000}s)`)), ms)
    ),
  ]);
}

function initFirebase() {
  if (admin.apps.length) return admin;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error(
      "Thiếu biến môi trường FIREBASE_SERVICE_ACCOUNT. " +
      "Vào Settings > Secrets and variables > Actions trên GitHub repo để khai báo."
    );
  }
  const serviceAccount = JSON.parse(raw);
  const databaseURL = process.env.FIREBASE_DATABASE_URL;
  if (!databaseURL) {
    throw new Error("Thiếu biến môi trường FIREBASE_DATABASE_URL.");
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL,
  });
  return admin;
}

// ---------------------------------------------------------------------------
// Vietcombank — nguồn XML chính thức, không cần trình duyệt
// ---------------------------------------------------------------------------
const VCB_XML_URL = "https://portal.vietcombank.com.vn/Usercontrols/TVPortal.TyGia/pXML.aspx";

function toNumberVCB(str) {
  if (str === undefined || str === null || str === "") return null;
  const n = parseFloat(String(str).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

async function scrapeVietcombank() {
  const res = await fetch(VCB_XML_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "Accept": "text/xml,application/xml,*/*",
      "Referer": "https://www.vietcombank.com.vn/",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Vietcombank XML fetch thất bại: HTTP ${res.status}`);
  const xml = await res.text();

  let parsed;
  try {
    parsed = await xml2js.parseStringPromise(xml);
  } catch (parseErr) {
    throw new Error(`${parseErr.message} | Phản hồi thực nhận (300 ký tự đầu): ${xml.slice(0, 300)}`);
  }
  const rows = parsed?.ExrateList?.Exrate || [];

  const result = {};
  for (const row of rows) {
    const attrs = row.$ || {};
    const code = (attrs.CurrencyCode || "").trim().toUpperCase();
    if (!WANTED.includes(code)) continue;
    result[code] = {
      muaTm: toNumberVCB(attrs.Buy),
      muaCk: toNumberVCB(attrs.Transfer),
      ban: toNumberVCB(attrs.Sell),
      banCk: null,
    };
  }

  const missing = WANTED.filter((c) => !result[c]);
  if (missing.length) {
    throw new Error(`Vietcombank: thiếu dữ liệu cho ${missing.join(", ")} — cấu trúc XML có thể đã đổi.`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// API tổng hợp vnappmob — mã khoá tự xin mỗi lần chạy
// ---------------------------------------------------------------------------
async function getVnappmobKey() {
  const res = await fetch("https://api.vnappmob.com/api/request_api_key?scope=exchange_rate", {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`xin api_key thất bại: HTTP ${res.status}`);
  const data = await res.json();
  if (!data.results) throw new Error("phản hồi xin api_key không có trường results");
  return data.results;
}

async function scrapeViaVnappmob(apiCode, apiKey) {
  const res = await fetch(`https://api.vnappmob.com/api/v2/exchange_rate/${apiCode}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`API ${apiCode} trả về HTTP ${res.status}`);
  const data = await res.json();
  const rows = data.results || [];

  const result = {};
  for (const row of rows) {
    const code = (row.currency || "").trim().toUpperCase();
    if (!WANTED.includes(code)) continue;
    const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
    result[code] = {
      muaTm: num(row.buy_cash ?? row.buy),
      muaCk: num(row.buy_transfer ?? row.buy),
      ban: num(row.sell),
      banCk: null,
      src: "api",
    };
  }
  if (Object.keys(result).length === 0) {
    throw new Error(
      `API ${apiCode} không trả về loại tiền nào trong ${WANTED.join(", ")} — ` +
      `phản hồi thô (400 ký tự đầu): ${JSON.stringify(data).slice(0, 400)}`
    );
  }
  return result;
}

const BANKS = [
  { bankCode: "BIDV", bankName: "BIDV", url: "https://bidv.com.vn/vn/ty-gia-ngoai-te", waitForText: "Mua tiền mặt", waitMs: 4000 },
  { bankCode: "VTB", bankName: "VietinBank", url: "https://www.vietinbank.vn/ca-nhan/ty-gia-khcn", waitForText: "USD", waitMs: 9000, apiCode: "ctg" },
  { bankCode: "AGR", bankName: "Agribank", url: "https://www.agribank.com.vn/vn/ty-gia", waitForText: "USD", waitMs: 3000 },
  { bankCode: "TCB", bankName: "Techcombank", url: "https://techcombank.com/cong-cu-tien-ich/ty-gia", waitForText: "USD", waitMs: 4000, apiCode: "tcb" },
  { bankCode: "EIB", bankName: "Eximbank", url: "https://eximbank.com.vn/bang-ty-gia", waitForText: "USD", waitMs: 3000 },
  { bankCode: "TPB", bankName: "TPBank", url: "https://tpb.vn/cong-cu-tinh-toan/ty-gia-ngoai-te", waitForText: "USD", waitMs: 4000 },
  { bankCode: "ACB", bankName: "ACB", url: "https://acb.com.vn/en/exchange-rate", waitForText: "USD", waitMs: 9000 },
  { bankCode: "MB", bankName: "MB", url: "https://www.mbbank.com.vn/ExchangeRate", waitForText: "USD", waitMs: 4000 },
];

// Các trang ngân hàng viết số không thống nhất: "25.870", "25,870",
// "25,870.00", "25.870,00", "161.39". Hàm này suy ra đâu là phân cách hàng
// nghìn, đâu là dấu thập phân.
function toNumberGeneric(str) {
  if (!str) return null;
  let s = String(str).trim().replace(/\s/g, "");
  if (!/\d/.test(s)) return null;

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");

  if (lastDot !== -1 && lastComma !== -1) {
    if (lastDot > lastComma) s = s.replace(/,/g, "");
    else s = s.replace(/\./g, "").replace(",", ".");
  } else if (lastDot !== -1 || lastComma !== -1) {
    const sep = lastDot !== -1 ? "." : ",";
    const pos = lastDot !== -1 ? lastDot : lastComma;
    const decimals = s.length - pos - 1;
    const occurrences = s.split(sep).length - 1;
    if (decimals === 3 || occurrences > 1) {
      s = s.split(sep).join("");
    } else {
      s = s.replace(sep, ".");
    }
  }

  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// Khoảng giá trị hợp lý của 1 đơn vị ngoại tệ quy ra VND.
const BANDS = {
  USD: [15000, 40000],
  EUR: [15000, 50000],
  JPY: [80, 400],
  THB: [300, 1500],
  GBP: [20000, 60000],
  AUD: [10000, 35000],
};

function inBand(code, v) {
  const b = BANDS[code];
  if (!b || v == null) return false;
  return v >= b[0] && v <= b[1];
}

// Nhiều ngân hàng tách USD theo mệnh giá tờ tiền: USD(1,2) / USD(5,10,20) /
// USD(50,100), giá mua tờ nhỏ thấp hơn hẳn. Dòng cần lấy là mệnh giá lớn nhất
// (hoặc dòng "USD" trơn). Trả về số càng nhỏ càng ưu tiên.
function denomPriority(lineText, code) {
  const idx = lineText.toUpperCase().indexOf(code);
  if (idx === -1) return 9;
  const tail = lineText.slice(idx + code.length, idx + code.length + 24);
  const paren = tail.match(/[([]([^)\]]{0,20})[)\]]/);
  if (!paren) return 1;                       // "USD" trơn
  const nums = (paren[1].match(/\d+/g) || []).map(Number).filter((n) => n <= 200);
  if (!nums.length) return 1;
  const max = Math.max(...nums);
  if (max >= 50) return 0;                    // (50,100) — mệnh giá lớn nhất
  if (max >= 5) return 2;                     // (5,10,20)
  return 3;                                   // (1,2)
}

function parseBodyText(bodyText, numbersPerRow) {
  const lines = bodyText.split("\n").map((l) => l.trim()).filter(Boolean);
  const result = {};
  const diagnostics = [];
  const picked = {};

  for (const code of WANTED) {
    const codeRegex = new RegExp(`\\b${code}\\b`);
    // Mã tiền tệ có thể xuất hiện nhiều chỗ (ô chọn ngoại tệ, các dòng mệnh
    // giá khác nhau...) — xếp theo ưu tiên mệnh giá rồi mới thử lần lượt.
    let candidateIdxs = lines.map((l, i) => (codeRegex.test(l) ? i : -1)).filter((i) => i !== -1);

    if (candidateIdxs.length === 0) {
      diagnostics.push(`${code}: không tìm thấy dòng nào chứa mã này trên trang`);
      continue;
    }

    candidateIdxs = candidateIdxs
      .map((i) => ({ i, p: denomPriority(lines[i], code) }))
      .sort((a, b) => a.p - b.p || a.i - b.i)
      .map((x) => x.i);

    let found = false;
    // Vòng 1: tìm dòng có đủ 3 số. Vòng 2: chấp nhận dòng chỉ có 2 số.
    for (const minNums of [numbersPerRow, 2]) {
      for (const lineIdx of candidateIdxs) {
        const windowText = lines.slice(lineIdx, lineIdx + 8).join(" ");
        const numberMatches = windowText.match(/\d[\d.,]*\d|\d/g) || [];
        const nums = numberMatches
          .map(toNumberGeneric)
          .filter((n) => inBand(code, n));

        if (nums.length >= minNums) {
          result[code] = (nums.length >= 3)
            ? { muaTm: nums[0], muaCk: nums[1], ban: nums[2], banCk: nums[3] ?? null, src: "web" }
            : { muaTm: null, muaCk: nums[0], ban: nums[1], banCk: null, src: "web2" };
          // Ghi lại đúng đoạn đã đọc, để khi số ra sai còn biết nó lấy từ
          // dòng nào trên trang mà sửa cho trúng.
          picked[code] = `${lines[lineIdx].slice(0, 45)} → ${nums.slice(0, 4).join(" | ")}`;
          found = true;
          break;
        }
      }
      if (found) break;
    }

    if (!found) {
      const firstWindow = lines.slice(candidateIdxs[0], candidateIdxs[0] + 8).join(" ");
      diagnostics.push(`${code}: thấy mã ở ${candidateIdxs.length} chỗ nhưng không chỗ nào đủ số — ví dụ: "${firstWindow.slice(0, 150)}"`);
    }
  }
  return { result, diagnostics, picked };
}

function harvestRatesFromJson(node, out = {}) {
  if (!node || typeof node !== "object") return out;

  if (Array.isArray(node)) {
    for (const item of node) harvestRatesFromJson(item, out);
    return out;
  }

  const values = Object.values(node);
  const strs = values.filter((v) => typeof v === "string");
  const code = strs.map((s) => s.trim().toUpperCase()).find((s) => WANTED.includes(s));

  if (code) {
    const nums = [];
    for (const v of values) {
      const n = typeof v === "number" ? v : toNumberGeneric(v);
      if (inBand(code, n)) nums.push(n);
    }
    if (nums.length >= 2) {
      // Đủ 3 số: mua TM / mua CK / bán. Chỉ 2 số: coi là mua CK và bán, KHÔNG
      // nhân đôi một số cho hai cột (sẽ ra mua = bán, vô lý).
      const candidate = (nums.length >= 3)
        ? { muaTm: nums[0], muaCk: nums[1], ban: nums[2], banCk: null, src: "xhr" }
        : { muaTm: null, muaCk: nums[0], ban: nums[1], banCk: null, src: "xhr" };
      // JSON thường liệt kê cả mệnh giá nhỏ với giá mua thấp hơn. Giữ bản ghi
      // có giá mua cao nhất — đó là mệnh giá lớn / loại "USD" thông thường.
      const prev = out[code];
      const score = (r) => Math.max(r.muaTm || 0, r.muaCk || 0);
      if (!prev || score(candidate) > score(prev)) out[code] = candidate;
    }
  }

  for (const v of values) harvestRatesFromJson(v, out);
  return out;
}

async function tryClickCurrency(page, code) {
  return page.evaluate((code) => {
    const all = document.querySelectorAll("body *");
    for (const el of all) {
      if (el.children.length === 0 && el.textContent.trim() === code) {
        el.click();
        return true;
      }
    }
    return false;
  }, code);
}

async function scrapeGenericBankTable({ url, waitForText = "USD", waitMs = 3000, numbersPerRow = 3 }) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    );

    const apiRates = {};
    page.on("response", async (res) => {
      try {
        const ct = res.headers()["content-type"] || "";
        if (!ct.includes("json")) return;
        const json = await res.json();
        harvestRatesFromJson(json, apiRates);
      } catch {
        // Phản hồi không đọc được hoặc không phải JSON hợp lệ — bỏ qua.
      }
    });

    // Trang ngân hàng đôi khi tải rất chậm. Thử cách chặt trước; nếu quá hạn
    // thì thử lại theo cách nhẹ hơn.
    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout: 40000 });
    } catch (navErr) {
      console.log(`   ↻ tải lại nhẹ hơn (lần đầu quá hạn)`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 });
    }

    try {
      await page.waitForFunction(
        (text) => document.body && document.body.innerText.includes(text),
        { timeout: 10000 },
        waitForText
      );
    } catch {
      // Không thấy text mong đợi — vẫn thử đọc.
    }

    await new Promise((r) => setTimeout(r, waitMs));
    let bodyText = await page.evaluate(() => document.body.innerText);
    const parsed = parseBodyText(bodyText, numbersPerRow);

    for (const code of WANTED) {
      if (!parsed.result[code] && apiRates[code]) {
        parsed.result[code] = apiRates[code];
        const idx = parsed.diagnostics.findIndex((d) => d.startsWith(`${code}:`));
        if (idx !== -1) parsed.diagnostics.splice(idx, 1);
      }
    }

    const stillMissing = WANTED.filter((c) => !parsed.result[c]);
    for (const code of stillMissing) {
      let clicked = false;
      try {
        clicked = await tryClickCurrency(page, code);
      } catch {
        continue;
      }
      if (!clicked) continue;
      await new Promise((r) => setTimeout(r, 1800));
      bodyText = await page.evaluate(() => document.body.innerText);
      const reparsed = parseBodyText(bodyText, numbersPerRow);
      if (reparsed.result[code]) {
        parsed.result[code] = reparsed.result[code];
        if (reparsed.picked && reparsed.picked[code]) parsed.picked[code] = reparsed.picked[code];
        const idx = parsed.diagnostics.findIndex((d) => d.startsWith(`${code}:`));
        if (idx !== -1) parsed.diagnostics.splice(idx, 1);
      }
    }

    return { ...parsed, bodyLength: bodyText.length, rawSnippet: bodyText.slice(0, 400) };
  } finally {
    await browser.close();
  }
}

// Ngân hàng luôn bán cao hơn mua. Sắp xếp lại 3 giá trị tăng dần để sửa các
// trường hợp đọc lệch thứ tự cột.
function normalizeRate(rate) {
  if (!rate) return rate;
  const fields = ["muaTm", "muaCk", "ban"];
  const present = fields.filter((f) => rate[f] != null);
  if (present.length < 2) return rate;

  const sorted = present.map((f) => rate[f]).sort((a, b) => a - b);
  const out = { ...rate };
  present.forEach((f, i) => { out[f] = sorted[i]; });

  // Chênh lệch mua–bán bằng 0 nghĩa là đọc trùng ô. Bỏ giá mua, giữ giá bán.
  if (out.muaCk != null && out.ban != null && out.muaCk === out.ban) out.muaCk = null;
  if (out.muaTm != null && out.ban != null && out.muaTm === out.ban) out.muaTm = null;
  return out;
}

// Đối chiếu với Vietcombank — lệch quá 12% gần như chắc chắn là đọc nhầm ô.
function crossCheck(bankName, code, rate, reference) {
  if (!reference) return rate;
  const ref = reference.muaCk || reference.ban || reference.muaTm;
  if (!ref) return rate;

  const out = { ...rate };
  for (const field of ["muaTm", "muaCk", "ban"]) {
    const v = out[field];
    if (v == null) continue;
    const diff = Math.abs(v - ref) / ref;
    if (diff > 0.12) {
      console.log(`   ⚠️  ${bankName} ${code}.${field} = ${v} lệch ${(diff * 100).toFixed(0)}% so với VCB (${ref}) — bỏ qua`);
      out[field] = null;
    }
  }
  if (out.muaTm == null && out.muaCk == null && out.ban == null) return null;
  return out;
}

function todayISO() {
  const now = new Date();
  const vnMs = now.getTime() + (7 * 60 - now.getTimezoneOffset()) * 60000;
  return new Date(vnMs).toISOString().slice(0, 10);
}

async function run() {
  const adminApp = initFirebase();
  const db = adminApp.database();
  const date = todayISO();

  const results = {};
  const errors = [];

  console.log("Bắt đầu: Vietcombank");
  try {
    results.VCB = {
      name: "Vietcombank",
      rates: await withTimeout(scrapeVietcombank(), 20000, "Vietcombank"),
      date,
      updatedAt: new Date().toISOString(),
    };
    console.log("✅ Vietcombank: OK");
  } catch (err) {
    errors.push({ bank: "Vietcombank", error: err.message });
    console.error(`❌ Vietcombank: ${err.message}`);
  }

  let apiKey = null;
  try {
    apiKey = await withTimeout(getVnappmobKey(), 15000, "vnappmob key");
    console.log("Đã lấy được api_key vnappmob");
  } catch (err) {
    console.error(`⚠️  Không lấy được api_key vnappmob: ${err.message} — sẽ chỉ dùng cách cào trực tiếp.`);
  }

  for (const bank of BANKS) {
    console.log(`Bắt đầu: ${bank.bankName}`);
    let rates = {};
    const notes = [];

    if (bank.apiCode && apiKey) {
      try {
        rates = await withTimeout(scrapeViaVnappmob(bank.apiCode, apiKey), 20000, `${bank.bankName} (API)`);
        console.log(`   ↳ API vnappmob: lấy được ${Object.keys(rates).join(", ")}`);
      } catch (err) {
        notes.push(`API: ${err.message}`);
        console.error(`   ↳ API vnappmob lỗi: ${err.message}`);
      }
    }

    if (WANTED.some((c) => !rates[c])) {
      try {
        const { result, diagnostics, bodyLength, rawSnippet, picked } =
          await withTimeout(scrapeGenericBankTable(bank), 110000, bank.bankName);
        if (picked) {
          for (const [c, txt] of Object.entries(picked)) {
            console.log(`   · ${c} đọc từ: "${txt}"`);
          }
        }
        for (const code of WANTED) {
          if (!rates[code] && result[code]) rates[code] = result[code];
        }
        if (WANTED.some((c) => !rates[c])) {
          notes.push(`cào trực tiếp (trang ${bodyLength} ký tự): ${diagnostics.join(" || ")}`);
          if (Object.keys(result).length === 0 && rawSnippet) notes.push(`nội dung trang: "${rawSnippet}"`);
        }
      } catch (err) {
        notes.push(`cào trực tiếp: ${err.message}`);
      }
    }

    // Chuẩn hoá thứ tự mua/bán, rồi đối chiếu với Vietcombank.
    for (const code of Object.keys(rates)) {
      rates[code] = normalizeRate(rates[code]);
    }
    const vcbRates = results.VCB && results.VCB.rates;
    if (vcbRates) {
      for (const code of Object.keys(rates)) {
        const checked = crossCheck(bank.bankName, code, rates[code], vcbRates[code]);
        if (checked) rates[code] = checked;
        else delete rates[code];
      }
    }

    const gotCodes = Object.keys(rates);
    if (gotCodes.length === 0) {
      errors.push({ bank: bank.bankName, error: notes.join(" | ") || "không lấy được dữ liệu" });
      console.error(`❌ ${bank.bankName}: ${notes.join(" | ")}`);
      continue;
    }

    results[bank.bankCode] = { name: bank.bankName, rates, date, updatedAt: new Date().toISOString() };
    const srcSummary = Object.entries(rates).map(([c, r]) => `${c}:${r.src || "?"}`).join(" ");
    console.log(`   ↳ nguồn: ${srcSummary}`);
    const missing = WANTED.filter((c) => !rates[c]);
    if (missing.length) {
      console.log(`⚠️  ${bank.bankName}: thiếu ${missing.join(", ")} — vẫn lưu ${gotCodes.join(", ")}`);
      if (notes.length) console.log(`   ↳ lý do: ${notes.join(" | ")}`);
      errors.push({ bank: bank.bankName, error: `thiếu ${missing.join(", ")}`, partial: true });
    } else {
      console.log(`✅ ${bank.bankName}: OK`);
    }
  }

  if (Object.keys(results).length === 0) {
    throw new Error("Không lấy được dữ liệu từ bất kỳ ngân hàng nào — dừng, không ghi đè dữ liệu cũ.");
  }

  const updates = {};
  for (const [code, data] of Object.entries(results)) {
    updates[`rates/${date}/${code}`] = data;
    updates[`latest/banks/${code}`] = data;
  }
  updates["latest/date"] = date;
  updates["latest/updatedAt"] = new Date().toISOString();
  updates["latest/partial"] = errors.length > 0;
  updates["latest/errors"] = errors;

  await db.ref().update(updates);

  console.log(`\nGhi Firebase xong: ${Object.keys(results).length}/${BANKS.length + 1} ngân hàng thành công.`);
  if (errors.length) {
    console.log("Các ngân hàng lỗi (cần hiệu chỉnh):");
    for (const e of errors) console.log(`  - ${e.bank}: ${e.error}`);
  }
}

run().catch((err) => {
  console.error("LỖI NGHIÊM TRỌNG:", err);
  process.exit(1);
});
