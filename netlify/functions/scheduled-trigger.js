// Function này KHÔNG có nút bấm nào cả — Netlify tự động gọi nó theo đúng
// lịch khai báo bên dưới (giờ UTC), độc lập hoàn toàn với cron của GitHub
// Actions (vốn không đáng tin cậy với các repo ít hoạt động).
//
// Lịch: 8h, 10h, 12h, 14h, 16h, 17h giờ Việt Nam (UTC+7), thứ 2 đến thứ 7.
// Đổi giờ VN sang UTC bằng cách trừ 7.
//
// Dùng lại đúng 2 biến môi trường đã khai báo sẵn cho trigger-update.js:
//   GITHUB_TOKEN, GITHUB_REPO

const { schedule } = require("@netlify/functions");

const runTrigger = async function () {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;

  if (!token || !repo) {
    console.error("Thiếu GITHUB_TOKEN hoặc GITHUB_REPO trên Netlify.");
    return { statusCode: 500, body: "Missing config" };
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/daily-update.yml/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: "main" }),
      }
    );

    if (res.status === 204) {
      console.log("Đã kích hoạt daily-update.yml theo lịch Netlify thành công.");
      return { statusCode: 200, body: "OK" };
    }

    const text = await res.text();
    console.error(`GitHub trả về lỗi: ${res.status} ${text}`);
    return { statusCode: res.status, body: text };
  } catch (err) {
    console.error(`Lỗi khi gọi GitHub: ${err.message}`);
    return { statusCode: 500, body: err.message };
  }
};

exports.handler = schedule("0 1,3,5,7,9,10 * * 1-6", runTrigger);
