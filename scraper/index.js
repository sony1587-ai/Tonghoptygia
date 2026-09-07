
// ============================================================================
// scraper/index.js — TOÀN BỘ logic cào tỷ giá 9 ngân hàng + ghi Firebase,
// gộp vào 1 file duy nhất (để dễ tạo thủ công trên GitHub qua điện thoại).
// Chạy bởi GitHub Actions (lịch hàng ngày) hoặc thủ công (npm run scrape).
// ============================================================================

const admin = require("firebase-admin");
const xml2js = require("xml2js");
const puppeteer = require("puppeteer");

const WANTED = ["USD", "EUR", "JPY", "THB"];

// ---------------------------------------------------------------------------
// 1. Khởi tạo Firebase Admin SDK
// ---------------------------------------------------------------------------
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
// 2. Vietcombank — nguồn XML tĩnh chính thức, không cần trình duyệt
// ---------------------------------------------------------------------------
const VCB_XML_URL = "https://www.vietcombank.com.vn/exchangerates/ExrateXML.aspx";

function toNumberVCB(str) {
  if (str === undefined || str === null || str === "") return null;
  const n = parseFloat(String(str).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

async function scrapeVietcombank() {
  const res = await fetch(VCB_XML_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; tygia-bigbanks-bot/1.0)" },
  });
  if (!res.ok) throw new Error(`Vietcombank XML fetch thất bại: HTTP ${res.status}`);
  const xml = await res.text();

  const parsed = await xml2js.parseStringPromise(xml);
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
// 3. 8 ngân hàng còn lại — đọc bằng trình duyệt ảo (Puppeteer), parse theo
//    text hiển thị (bền hơn dò CSS class cụ thể, nhưng vẫn có thể cần hiệu
//    chỉnh waitForText/waitMs sau lần chạy thật đầu tiên — xem README).
// ---------------------------------------------------------------------------
const BANKS = [
  { bankCode: "BIDV", bankName: "BIDV", url: "https://bidv.com.vn/vn/ty-gia-ngoai-te", waitForText: "Mua tiền mặt", waitMs: 4000 },
  { bankCode: "VTB", bankName: "VietinBank", url: "https://www.vietinbank.vn/ca-nhan/ty-gia-khcn", waitForText: "USD", waitMs: 4000 },
  { bankCode: "AGR", bankName: "Agribank", url: "https://www.agribank.com.vn/vn/ty-gia", waitForText: "USD", waitMs: 3000 },
  { bankCode: "TCB", bankName: "Techcombank", url: "https://techcombank.com/cong-cu-tien-ich/ty-gia", waitForText: "USD", waitMs: 4000 },
  { bankCode: "EIB", bankName: "Eximbank", url: "https://eximbank.com.vn/bang-ty-gia", waitForText: "USD", waitMs: 3000 },
  { bankCode: "TPB", bankName: "TPBank", url: "https://tpb.vn/cong-cu-tinh-toan/ty-gia-ngoai-te", waitForText: "USD", waitMs: 4000 },
  { bankCode: "ACB", bankName: "ACB", url: "https://acb.com.vn/exchange-rate", waitForText: "USD", waitMs: 4000 },
  { bankCode: "MB", bankName: "MB", url: "https://www.mbbank.com.vn/ExchangeRate", waitForText: "USD", waitMs: 4000 },
];

function toNumberGeneric(str) {
  if (!str) return null;
  const n = parseFloat(str.replace(/\./g, "").replace(/,/g, "."));
  return Number.isFinite(n) ? n : null;
}

function parseBodyText(bodyText, numbersPerRow) {
  const lines = bodyText.split("\n").map((l) => l.trim()).filter(Boolean);
  const result = {};

  for (const code of WANTED) {
    const codeRegex = new RegExp(`\\b${code}\\b`);
    const lineIdx = lines.findIndex((l) => codeRegex.test(l));
    if (lineIdx === -1) continue;

    const windowText = lines.slice(lineIdx, lineIdx + 8).join(" ");
    const numberMatches = windowText.match(/[\d]{1,3}(?:[.,]\d{2,3})+|\d+[.,]\d+/g) || [];
    const nums = numberMatches.map(toNumberGeneric).filter((n) => n !== null && n > 0);

    if (nums.length >= numbersPerRow) {
      result[code] = { muaTm: nums[0] ?? null, muaCk: nums[1] ?? null, ban: nums[2] ?? null, banCk: nums[3] ?? null };
    }
  }
  return result;
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
    await page.goto(url, { waitUntil: "networkidle2", timeout: 25000 });

    try {
      await page.waitForFunction(
        (text) => document.body && document.body.innerText.includes(text),
        { timeout: 10000 },
        waitForText
      );
    } catch {
      // Không thấy text mong đợi — vẫn thử đọc, lỗi cụ thể hơn sẽ báo ở bước parse.
    }

    await new Promise((r) => setTimeout(r, waitMs));
    const bodyText = await page.evaluate(() => document.body.innerText);
    return parseBodyText(bodyText, numbersPerRow);
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// 4. Điều phối chính: chạy tất cả, ghi vào Firebase
// ---------------------------------------------------------------------------
function todayISO() {
  const now = new Date();
  const vnMs = now.getTime() + (7 * 60 - now.getTimezoneOffset()) * 60000;
  return new Date(vnMs).toISOString().slice(0, 10); // YYYY-MM-DD, giờ VN
}

async function run() {
  const adminApp = initFirebase();
  const db = adminApp.database();
  const date = todayISO();

  const results = {};
  const errors = [];

  try {
    results.VCB = { name: "Vietcombank", rates: await scrapeVietcombank() };
    console.log("✅ Vietcombank: OK");
  } catch (err) {
    errors.push({ bank: "Vietcombank", error: err.message });
    console.error(`❌ Vietcombank: ${err.message}`);
  }

  for (const bank of BANKS) {
    try {
      const rates = await scrapeGenericBankTable(bank);
      const gotAll = WANTED.every((c) => rates[c]);
      if (!gotAll) {
        throw new Error(`chỉ lấy được ${Object.keys(rates).join(", ") || "không có"} — cần hiệu chỉnh waitForText`);
      }
      results[bank.bankCode] = { name: bank.bankName, rates };
      console.log(`✅ ${bank.bankName}: OK`);
    } catch (err) {
      errors.push({ bank: bank.bankName, error: err.message });
      console.error(`❌ ${bank.bankName}: ${err.message}`);
    }
  }

  if (Object.keys(results).length === 0) {
    throw new Error("Không lấy được dữ liệu từ bất kỳ ngân hàng nào — dừng, không ghi đè dữ liệu cũ.");
  }

  const updates = {};
  for (const [code, data] of Object.entries(results)) {
    updates[`rates/${date}/${code}`] = data;
  }
  updates["latest"] = {
    date,
    updatedAt: new Date().toISOString(),
    banks: results,
    partial: errors.length > 0,
    errors,
  };

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
