// Netlify Function đứng sau nút "Cập nhật ngay" trên dashboard.
// KHÔNG chạy Puppeteer ở đây — chỉ gửi 1 lệnh gọi API tới GitHub để GitHub
// Actions tự chạy lại workflow "daily-update.yml" ngay lập tức.
//
// Cần khai báo 2 biến môi trường trong Netlify (Site settings > Environment
// variables), KHÔNG khai báo trong code hay gửi qua chat:
//   GITHUB_TOKEN  - Personal Access Token (fine-grained), quyền "Actions: write"
//                   trên đúng 1 repo này
//   GITHUB_REPO   - dạng "ten-tai-khoan/ten-repo"

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;

  if (!token || !repo) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        ok: false,
        message: "Thiếu cấu hình GITHUB_TOKEN hoặc GITHUB_REPO trên Netlify.",
      }),
    };
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
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: true,
          message: "Đã yêu cầu cập nhật — thường mất 2-3 phút để xong, dashboard sẽ tự làm mới.",
        }),
      };
    }

    const text = await res.text();
    return {
      statusCode: res.status,
      body: JSON.stringify({ ok: false, message: `GitHub trả về lỗi: ${res.status} ${text}` }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, message: `Lỗi khi gọi GitHub: ${err.message}` }),
    };
  }
};
