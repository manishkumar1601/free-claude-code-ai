// Single inline HTML page. No build step, no JS framework.

export const dashboardHtml = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>free-claude-code</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; max-width: 960px;
         margin: 2rem auto; padding: 0 1rem; background: #0d1117; color: #c9d1d9; }
  h1 { font-size: 1.4rem; margin-bottom: 0.2rem; }
  h2 { font-size: 1rem; margin-top: 2rem; color: #8b949e; text-transform: uppercase;
       letter-spacing: 0.05em; border-bottom: 1px solid #30363d; padding-bottom: 0.3rem; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #21262d; }
  th { color: #8b949e; font-weight: 500; }
  tr:hover td { background: #161b22; }
  code { background: #161b22; padding: 0.1rem 0.4rem; border-radius: 3px; }
  .num { font-variant-numeric: tabular-nums; text-align: right; }
  .muted { color: #6e7681; }
  pre { background: #161b22; padding: 0.6rem; border-radius: 4px;
        overflow: auto; max-height: 360px; font-size: 12px; }
  .row { display: flex; gap: 2rem; flex-wrap: wrap; }
  .row > div { flex: 1; min-width: 180px; }
  .big { font-size: 1.6rem; font-weight: 600; }
</style>
</head>
<body>
  <h1>free-claude-code</h1>
  <div class="muted">drop-in proxy · refreshing every 5s</div>

  <h2>Configuration</h2>
  <table id="cfg"></table>

  <h2>Totals</h2>
  <div class="row" id="totals"></div>

  <h2>By provider</h2>
  <table id="byprov">
    <thead><tr><th>Provider</th><th class="num">Requests</th>
      <th class="num">In tokens</th><th class="num">Out tokens</th>
      <th class="num">Errors</th></tr></thead>
    <tbody></tbody>
  </table>

  <h2>Recent requests</h2>
  <pre id="log" class="muted">log file disabled — set LOG_REQUESTS=true</pre>

<script>
async function tick() {
  try {
    const [stats, info, log] = await Promise.all([
      fetch('/stats').then(r => r.json()),
      fetch('/info').then(r => r.json()),
      fetch('/logs').then(r => r.text()).catch(() => ''),
    ]);

    const cfg = document.getElementById('cfg');
    cfg.innerHTML = '';
    for (const [k, v] of Object.entries(info)) {
      const tr = cfg.insertRow();
      tr.innerHTML = '<td class="muted">' + k + '</td><td><code>' + v + '</code></td>';
    }

    const t = stats.totals;
    document.getElementById('totals').innerHTML =
      tile('Requests', t.requests) +
      tile('In tokens', t.inputTokens) +
      tile('Out tokens', t.outputTokens) +
      tile('Cache hits', t.cacheHits) +
      tile('Errors', t.errors);

    const tbody = document.querySelector('#byprov tbody');
    tbody.innerHTML = '';
    for (const [name, b] of Object.entries(stats.byProvider || {})) {
      const tr = tbody.insertRow();
      tr.innerHTML = '<td>' + name + '</td>' +
        '<td class="num">' + b.requests + '</td>' +
        '<td class="num">' + b.inputTokens + '</td>' +
        '<td class="num">' + b.outputTokens + '</td>' +
        '<td class="num">' + b.errors + '</td>';
    }

    if (log) document.getElementById('log').textContent = log;
  } catch (err) { console.error(err); }
}
function tile(label, n) {
  return '<div><div class="muted">' + label + '</div>' +
         '<div class="big">' + Number(n).toLocaleString() + '</div></div>';
}
tick();
setInterval(tick, 5000);
</script>
</body>
</html>`;
