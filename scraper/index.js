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
  { bankCode: "STB", bankName: "Sacombank", url: "https://www.sacombank.com.vn/cong-cu/ty-gia.html", waitForText: "USD", waitMs: 6000, apiCode: "stb" },
  { bankCode: "BIDV", bankName: "BIDV", url: "https://bidv.com.vn/vn/ty-gia-ngoai-te", waitForText: "Mua tiền mặt", waitMs: 4000 },
  { bankCode: "VTB", bankName: "VietinBank", url: "https://www.vietinbank.vn/ca-nhan/ty-gia-khcn", waitForText: "USD", waitMs: 9000, apiCode: "ctg" },
  { bankCode: "AGR", bankName: "Agribank", url: "https://www.agribank.com.vn/vn/ty-gia", waitForText: "USD", waitMs: 3000 },
  { bankCode: "TCB", bankName: "Techcombank", url: "https://techcombank.com/cong-cu-tien-ich/ty-gia", waitForText: "USD", waitMs: 4000, apiCode: "tcb" },
  { bankCode: "EIB", bankName: "Eximbank", url: "https://eximbank.com.vn/bang-ty-gia", waitForText: "USD", waitMs: 6000 },
  { bankCode: "TPB",
