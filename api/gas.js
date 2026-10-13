const GAS_URL = 'https://script.google.com/a/macros/socar.kr/s/AKfycbzv6cxBf_5u5HjAyd74huTmvXB4vIKqUijtt09kxfV6/exec';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const target = GAS_URL + qs;

  try {
    const r = await fetch(target, { redirect: 'follow', headers: { Accept: 'application/json' } });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); }
    catch { data = { error: 'GAS non-JSON: ' + text.slice(0, 200) }; }
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
