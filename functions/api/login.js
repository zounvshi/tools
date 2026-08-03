// functions/api/login.js
export async function onRequest(context) {
  // 只接受 POST 请求
  if (context.request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const { password } = await context.request.json();
    // 从环境变量读取正确的密码哈希（建议使用 bcrypt，这里为了简便直接比对明文，但务必在环境变量存储）
    const validPassword = context.env.ADMIN_PASSWORD; // 在 Cloudflare Dashboard 设置

    if (password === validPassword) {
      // 登录成功，返回一个简短 token（实际项目可返回 JWT）
      return new Response(JSON.stringify({ success: true, message: '登录成功' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } else {
      return new Response(JSON.stringify({ success: false, message: '密码错误' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  } catch (err) {
    return new Response(JSON.stringify({ success: false, message: '请求格式错误' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}