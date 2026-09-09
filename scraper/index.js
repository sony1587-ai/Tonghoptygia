// ============================================================================
// scraper/index.js — Cào tỷ giá 10 ngân hàng + ghi Firebase.
// Nguồn chính: trang tỷ giá chính thức của từng ngân hàng.
// Nguồn phụ: API tổng hợp vnappmob, chỉ dùng bù chỗ trang không đọc được.
// Ghi 3 nhánh: /latest (bảng hiện tại), /rates (đầy đủ theo ngày),
// /history (bản gọn để vẽ biểu đồ). Tự dọn dữ liệu quá 3 tháng.
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
// API tổng hợp vnappmob (NGUỒN PHỤ) — mã khoá tự xin mỗi lần chạy
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
      ban: num(row.sell_cash ?? row.sell),
      banCk: num(row.sell_transfer ?? row.sell),
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
  { bankCode: "STB", bankName: "Sacombank", url: "https://www.sacombank.com.vn/cong-cu/ty-gia.html", waitForText: "USD", waitMs: 6000, apiCode: "stb" },
  { bankCode: "BIDV", bankName: "BIDV", url: "https://bidv.com.vn/vn/ty-gia-ngoai-te", waitForText: "Mua tiền mặt", waitMs: 4000 },
  { bankCode: "VTB", bankName: "VietinBank", url: "https://www.vietinbank.vn/ca-nhan/ty-gia-khcn", waitForText: "USD", waitMs: 9000, apiCode: "ctg" },
  { bankCode: "AGR", bankName: "Agribank", url: "https://www.agribank.com.vn/vn/ty-gia", waitForText: "USD", waitMs: 3000 },
  { bankCode: "TCB", bankName: "Techcombank", url: "https://techcombank.com/cong-cu-tien-ich/ty-gia", waitForText: "USD", waitMs: 4000, apiCode: "tcb" },
  { bankCode: "EIB", bankName: "Eximbank", url: "https://eximbank.com.vn/bang-ty-gia", waitForText: "USD", waitMs: 6000 },
  { bankCode: "TPB", bankName: "TPBank", url: "https://tpb.vn/cong-cu-tinh-toan/ty-gia-ngoai-te", waitForText: "USD", waitMs: 4000 },
  { bankCode: "ACB", bankName: "ACB", url: "https://acb.com.vn/en/exchange-rate", waitForText: "USD", waitMs: 9000 },
  { bankCode: "MB", bankName: "MB", url: "https://www.mbbank.com.vn/ExchangeRate", waitForText: "MUA VÀO", waitForAbsence: "***", waitMs: 10000 },
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

// Cửa sổ quét thường lấn sang dòng ngoại tệ kế tiếp, nên con số thứ 4 nhiều
// khi không phải "giá bán thứ hai" mà là số của dòng khác. Chỉ chấp nhận nó
// nếu chênh lệch với giá bán không quá 3% — hai giá bán tiền mặt và chuyển
// khoản của cùng một ngân hàng luôn sát nhau.
function looksLikeSecondSell(v, sell) {
  if (v == null || sell == null) return false;
  return Math.abs(v - sell) / sell <= 0.03;
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
    let candidateIdxs = lines.map((l, i) => (codeRegex.test(l) ? i : -1)).filter((i) => i !== -1);

    if (candidateIdxs.length === 0) {
      diagnostics.push(`${code}: không tìm thấy dòng nào chứa mã này trên trang`);
      continue;
    }

    // Ưu tiên dòng mệnh giá lớn (USD 50-100) hoặc dòng không ghi mệnh giá.
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
            ? {
                muaTm: nums[0],
                muaCk: nums[1],
                ban: nums[2],
                banCk: looksLikeSecondSell(nums[3], nums[2]) ? nums[3] : null,
                src: "web",
              }
            : { muaTm: null, muaCk: nums[0], ban: nums[1], banCk: null, src: "web2" };
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
      const candidate = (nums.length >= 4 && looksLikeSecondSell(nums[3], nums[2]))
        ? { muaTm: nums[0], muaCk: nums[1], ban: nums[2], banCk: nums[3], src: "xhr" }
        : (nums.length >= 3)
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

async function scrapeGenericBankTable({ url, waitForText = "USD", waitForAbsence = null, waitMs = 3000, numbersPerRow = 3 }) {
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

    // Một số trang (MB) trả về khung mẫu chưa điền số, chứa các ký hiệu như
    // "***x.buy_cash***". Chờ đến khi ký hiệu đó biến mất mới đọc.
    if (waitForAbsence) {
      try {
        await page.waitForFunction(
          (mark) => document.body && !document.body.innerText.includes(mark),
          { timeout: 20000 },
          waitForAbsence
        );
      } catch {
        console.log(`   ⏳ vẫn còn khung mẫu chưa điền số sau 20s`);
      }
    }
    // Dấu hiệu chắc chắn nhất cho biết bảng đã có số: trên trang xuất hiện một
    // con số dạng tỷ giá (vd 25.780 hoặc 25,780). Chờ tiêu đề cột hay ký hiệu
    // khung mẫu đều không đủ — chúng hiện ra trước khi dữ liệu kịp đổ vào.
    try {
      await page.waitForFunction(
        () => /\d{2}[.,]\d{3}/.test(document.body ? document.body.innerText : ""),
        { timeout: 20000 }
      );
    } catch {
      console.log(`   ⏳ chưa thấy con số tỷ giá nào sau 20s`);
    }

    await new Promise((r) => setTimeout(r, waitMs));
    let bodyText = await page.evaluate(() => document.body.innerText);
    const parsed = parseBodyText(bodyText, numbersPerRow);

    // Bù bằng dữ liệu bắt được từ lệnh gọi JSON ngầm của CHÍNH trang đó —
    // vẫn là dữ liệu ngân hàng, không phải bên thứ ba.
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

// Trật tự luôn đúng trong nghiệp vụ: mua tiền mặt ≤ mua chuyển khoản ≤
// bán chuyển khoản ≤ bán tiền mặt (ngân hàng bán tiền mặt đắt hơn chuyển
// khoản, và luôn bán cao hơn mua). Sắp xếp lại theo trật tự này để sửa các
// trường hợp đọc lệch cột.
function normalizeRate(rate) {
  if (!rate) return rate;
  const order = ["muaTm", "muaCk", "banCk", "ban"];
  const present = order.filter((f) => rate[f] != null);
  const out = { ...rate };

  if (present.length >= 2) {
    const sorted = present.map((f) => rate[f]).sort((a, b) => a - b);
    present.forEach((f, i) => { out[f] = sorted[i]; });
  }

  // Ngân hàng chỉ niêm yết một giá bán → dùng chung cho cả hai cột.
  if (out.ban != null && out.banCk == null) out.banCk = out.ban;
  if (out.banCk != null && out.ban == null) out.ban = out.banCk;

  // Chênh lệch mua–bán bằng 0 nghĩa là đọc trùng ô. Bỏ giá mua, giữ giá bán.
  if (out.muaCk != null && out.banCk != null && out.muaCk === out.banCk) out.muaCk = null;
  if (out.muaTm != null && out.banCk != null && out.muaTm === out.banCk) out.muaTm = null;
  return out;
}

// Đối chiếu với Vietcombank (nguồn XML chính thức, đáng tin nhất) — lệch quá
// 12% gần như chắc chắn là đọc nhầm ô.
function crossCheck(bankName, code, rate, reference) {
  if (!reference) return rate;
  const ref = reference.muaCk || reference.ban || reference.muaTm;
  if (!ref) return rate;

  const out = { ...rate };
  for (const field of ["muaTm", "muaCk", "ban", "banCk"]) {
    const v = out[field];
    if (v == null) continue;
    const diff = Math.abs(v - ref) / ref;
    if (diff > 0.12) {
      console.log(`   ⚠️  ${bankName} ${code}.${field} = ${v} lệch ${(diff * 100).toFixed(0)}% so với VCB (${ref}) — bỏ qua`);
      out[field] = null;
    }
  }
  if (out.muaTm == null && out.muaCk == null && out.ban == null && out.banCk == null) return null;
  return out;
}

// Xoá dữ liệu lịch sử cũ hơn số ngày giữ lại, để cơ sở dữ liệu không phình
// vô hạn. Firebase gói miễn phí đủ dùng thoải mái với 3 tháng dữ liệu.
const KEEP_DAYS = 92;

async function pruneOldHistory(db, todayStr) {
  const cutoff = new Date(todayStr);
  cutoff.setDate(cutoff.getDate() - KEEP_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const removals = {};
  let count = 0;

  const ratesSnap = await db.ref("rates").orderByKey().endAt(cutoffStr).once("value");
  ratesSnap.forEach((child) => { removals[`rates/${child.key}`] = null; count++; });

  for (const cur of WANTED) {
    const hSnap = await db.ref(`history/${cur}`).orderByKey().endAt(cutoffStr).once("value");
    hSnap.forEach((child) => { removals[`history/${cur}/${child.key}`] = null; count++; });
  }

  if (count) {
    await db.ref().update(removals);
    console.log(`🧹 Đã xoá ${count} mục dữ liệu cũ hơn ${cutoffStr}`);
  }
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
    const vcb = await withTimeout(scrapeVietcombank(), 20000, "Vietcombank");
    // Vietcombank chạy riêng ngoài vòng lặp nên phải tự gọi chuẩn hoá, nếu
    // không cột bán chuyển khoản sẽ bỏ trống.
    for (const code of Object.keys(vcb)) vcb[code] = normalizeRate(vcb[code]);
    results.VCB = { name: "Vietcombank", rates: vcb, date, updatedAt: new Date().toISOString() };
    console.log("✅ Vietcombank: OK");
  } catch (err) {
    errors.push({ bank: "Vietcombank", error: err.message });
    console.error(`❌ Vietcombank: ${err.message}`);
  }

  let apiKey = null;
  try {
    apiKey = await withTimeout(getVnappmobKey(), 15000, "vnappmob key");
    console.log("Đã lấy được api_key vnappmob (chỉ dùng làm nguồn phụ)");
  } catch (err) {
    console.error(`⚠️  Không lấy được api_key vnappmob: ${err.message}`);
  }

  for (const bank of BANKS) {
    console.log(`Bắt đầu: ${bank.bankName}`);
    let rates = {};
    const notes = [];

    // BƯỚC 1 — Nguồn chính: trang tỷ giá do chính ngân hàng công bố.
    try {
      const { result, diagnostics, bodyLength, rawSnippet, picked } =
        await withTimeout(scrapeGenericBankTable(bank), 110000, bank.bankName);
      if (picked) {
        for (const [c, txt] of Object.entries(picked)) {
          console.log(`   · ${c} đọc từ: "${txt}"`);
        }
      }
      rates = result;
      if (WANTED.some((c) => !rates[c])) {
        notes.push(`cào trực tiếp (trang ${bodyLength} ký tự): ${diagnostics.join(" || ")}`);
        if (Object.keys(result).length === 0 && rawSnippet) notes.push(`nội dung trang: "${rawSnippet}"`);
      }
    } catch (err) {
      notes.push(`cào trực tiếp: ${err.message}`);
      console.error(`   ↳ cào trang lỗi: ${err.message}`);
    }

    // BƯỚC 2 — Chỉ khi trang chính thức còn thiếu loại tiền nào mới lấy API
    // tổng hợp bên thứ ba bù vào, và đánh dấu riêng để người xem biết.
    const missingAfterWeb = WANTED.filter((c) => !rates[c]);
    if (missingAfterWeb.length && bank.apiCode && apiKey) {
      try {
        const apiRates = await withTimeout(scrapeViaVnappmob(bank.apiCode, apiKey), 20000, `${bank.bankName} (API)`);
        const filled = [];
        for (const code of missingAfterWeb) {
          if (apiRates[code]) { rates[code] = apiRates[code]; filled.push(code); }
        }
        if (filled.length) console.log(`   ↳ API vnappmob bù thêm: ${filled.join(", ")}`);
      } catch (err) {
        notes.push(`API: ${err.message}`);
        console.error(`   ↳ API vnappmob lỗi: ${err.message}`);
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
        if (!checked) { delete rates[code]; continue; }
        // Bước đối chiếu có thể đã loại một trong hai cột bán — điền lại từ
        // cột còn tốt để bảng không bị trống một nửa.
        if (checked.ban == null && checked.banCk != null) checked.ban = checked.banCk;
        if (checked.banCk == null && checked.ban != null) checked.banCk = checked.ban;
        rates[code] = checked;
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

    // Bản gọn cho biểu đồ: /history/{ngoại tệ}/{ngày}/{mã NH}.
    for (const [cur, r] of Object.entries(data.rates)) {
      updates[`history/${cur}/${date}/${code}`] = {
        tm: r.muaTm ?? null,
        ck: r.muaCk ?? null,
        b: r.ban ?? null,
        bck: r.banCk ?? null,
      };
    }
  }
  updates["latest/date"] = date;
  updates["latest/updatedAt"] = new Date().toISOString();
  updates["latest/partial"] = errors.length > 0;
  updates["latest/errors"] = errors;

  await db.ref().update(updates);

  try {
    await pruneOldHistory(db, date);
  } catch (err) {
    console.error(`⚠️  Dọn dữ liệu cũ thất bại (không ảnh hưởng dữ liệu hôm nay): ${err.message}`);
  }

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
