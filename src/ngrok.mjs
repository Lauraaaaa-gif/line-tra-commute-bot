export function checkedNgrokToken(value) {
  const token = (value || '').trim();
  if (!/^[A-Za-z0-9_-]{20,256}$/.test(token) || /YOUR_|AUTHTOKEN|TOKEN_HERE/i.test(token)) {
    throw new Error('NGROK_AUTHTOKEN_INVALID');
  }
  return token;
}

export function ngrokEnvironment(env, token) {
  // ngrok 不需要 LINE／TDX 金鑰；只傳系統執行環境與 ngrok 自己的憑證。
  const allowed = new Set(['path', 'pathext', 'systemroot', 'systemdrive', 'windir', 'comspec',
    'temp', 'tmp', 'userprofile', 'localappdata', 'appdata', 'home', 'homedrive', 'homepath',
    'programfiles', 'programfiles(x86)', 'programw6432', 'os', 'processor_architecture']);
  return {
    ...Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key.toLowerCase()))),
    NGROK_AUTHTOKEN: checkedNgrokToken(token),
  };
}

export function safeNgrokEvent(line) {
  if (typeof line !== 'string' || line.length > 65536) return null;
  // 錯誤只能輸出官方錯誤碼，不能印原始錯誤（可能包含無效 Token）。
  const code = line.match(/\bERR_NGROK_\d+\b/)?.[0];
  if (code) return { type: 'error', code };
  let data;
  try { data = JSON.parse(line); } catch { return null; }
  if (data?.msg !== 'started tunnel' || typeof data.url !== 'string') return null;
  try {
    const url = new URL(data.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) return null;
    if (!/\.(ngrok-free\.app|ngrok-free\.dev|ngrok\.app|ngrok\.dev|ngrok\.io)$/.test(url.hostname)) return null;
    return { type: 'url', url: url.origin };
  } catch { return null; }
}
