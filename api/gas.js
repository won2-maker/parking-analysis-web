const GAS_URL = 'https://script.google.com/a/macros/socar.kr/s/AKfycbzv6cxBf_5u5HjAyd74huTmvXB4vIKqUijtt09kxfV6/exec';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'X-GToken, Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const target = GAS_URL + qs;

  const headers = { Accept: 'application/json' };
  const gToken = req.headers['x-gtoken'];
  if (gToken) headers['Authorization'] = 'Bearer ' + gToken;

  try {
    const r = await fetch(target, { redirect: 'follow', headers });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); }
    catch {
      const preview = text.slice(0, 300);
      if (preview.includes('accounts.google.com') || preview.includes('signin')) {
        data = { error: 'GAS_AUTH_REQUIRED', message: '인증 필요 — socar.kr 계정으로 로그인하세요' };
      } else {
        data = { error: 'GAS non-JSON: ' + preview };
      }
    }
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
