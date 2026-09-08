// Netlify Function nhận dữ liệu nhập tay (dùng cho VietinBank — ngân hàng có
// màn hình xác minh chống robot nên không tự động cào được), xác thực bằng
// mật khẩu rồi ghi thẳng vào Firebase bằng Admin SDK.
//
// Cần khai báo 3 biến môi trường trên Netlify (Site configuration >
// Environment variables) — có thể trùng với 2 biến đã dùng cho GitHub Secrets:
//   FIREBASE_SERVICE_ACCOUNT   - nguyên nội dung file service account .json
//   FIREBASE_DATABASE_URL      - https://tonghoptygia-default-rtdb.asia-southeast1.firebasedatabase.app
//   MANUAL_UPDATE_PASSWORD     - mật khẩu tự đặt, chỉ A biết

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

    const data = {
      name: bankName,
      rates,
      source: "manual",
      updatedAt: new Date().toISOString(),
    };

    await db.ref().update({
      [`rates/${date}/${bankCode}`]: data,
      [`latest/banks/${bankCode}`]: data,
      [`latest/updatedAt`]: new Date().toISOString(),
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true, message: `Đã lưu tỷ giá ${bankName} nhập tay.` }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, message: `Lỗi khi ghi Firebase: ${err.message}` }) };
  }
};
