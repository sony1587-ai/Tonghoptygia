// Netlify Function nhận dữ liệu nhập tay, xác thực bằng mật khẩu rồi ghi
// thẳng vào Firebase bằng Admin SDK.
//
// Cần 3 biến môi trường trên Netlify (Site configuration > Environment
// variables): FIREBASE_SERVICE_ACCOUNT, FIREBASE_DATABASE_URL,
// MANUAL_UPDATE_PASSWORD.

const admin = require("firebase-admin");

function initFirebase() {
  if (admin.apps.length) return admin;
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
  return admin;
}

function todayISO() {
  const now = new Date();
  const vnMs = now.getTime() + (7 * 60 - now.getTimezoneOffset()) * 60000;
  return new Date(vnMs).toISOString().slice(0, 10);
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ ok: false, message: "Dữ liệu gửi lên không hợp lệ." }) };
  }

  const { password, bankCode, bankName, rates } = body || {};

  if (!process.env.MANUAL_UPDATE_PASSWORD) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, message: "Server chưa cấu hình MANUAL_UPDATE_PASSWORD." }) };
  }
  if (password !== process.env.MANUAL_UPDATE_PASSWORD) {
    return { statusCode: 401, body: JSON.stringify({ ok: false, message: "Sai mật khẩu." }) };
  }
  if (!bankCode || !bankName || !rates) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, message: "Thiếu bankCode, bankName hoặc rates." }) };
  }

  try {
    const adminApp = initFirebase();
    const db = adminApp.database();
    const date = todayISO();

    // Gộp với dữ liệu đã có thay vì ghi đè toàn bộ — tránh xoá mất các loại
    // tiền đã có sẵn khi chỉ bổ sung 1-2 loại.
    const existingSnap = await db.ref(`latest/banks/${bankCode}/rates`).once("value");
    const existingRates = existingSnap.val() || {};

        const tagged = {};
    for (const [code, r] of Object.entries(rates)) {
      const t = { ...r, src: "manual" };
      // Ngân hàng chỉ niêm yết một giá bán, hoặc người nhập chỉ điền một ô —
      // điền nốt ô còn lại để bảng không bị trống một nửa.
      if (t.ban != null && t.banCk == null) t.banCk = t.ban;
      if (t.banCk != null && t.ban == null) t.ban = t.banCk;
      tagged[code] = t;
    }

    const mergedRates = { ...existingRates, ...tagged };

    const data = {
      name: bankName,
      rates: mergedRates,
      source: "manual",
      date,
      updatedAt: new Date().toISOString(),
    };

    await db.ref().update({
      [`rates/${date}/${bankCode}`]: data,
      [`latest/banks/${bankCode}`]: data,
      [`latest/date`]: date,
      [`latest/updatedAt`]: new Date().toISOString(),
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true, message: `Đã lưu tỷ giá ${bankName} nhập tay.` }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, message: `Lỗi khi ghi Firebase: ${err.message}` }) };
  }
};
