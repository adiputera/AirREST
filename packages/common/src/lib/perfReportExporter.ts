import type { PerformanceRunReport } from '../types/api';
import { computePerformanceComparison, formatDeltaCompact } from './perfComparison';
import { formatThresholdRuleExpression } from './perfThresholds';

function escapeHtml(raw: string): string {
  return String(raw ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeJsonEmbed(data: unknown): string {
  return JSON.stringify(data).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
}

function csvEscape(value: string | number | boolean | null | undefined): string {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replaceAll('"', '""')}"`;
  }
  return str;
}

/**
 * Exports per-endpoint performance summary breakdown as an RFC 4180 CSV string.
 */
export function exportPerformanceEndpointsCsv(report: PerformanceRunReport): string {
  const headers = [
    'Request',
    'Method',
    'Path',
    'Total Requests',
    'Requests/sec',
    'Max Req/s',
    'Error Rate (%)',
    'Error Count',
    'Avg (ms)',
    'Min (ms)',
    'Max (ms)',
    'P90 (ms)',
    'P95 (ms)',
    'P99 (ms)',
    'Bytes Received',
  ];

  const rows: string[] = [headers.map(csvEscape).join(',')];
  const byReqPeak = new Map<string, number>();
  for (const b of report.timeSeries || []) {
    if (!b.byRequest) continue;
    for (const [reqId, rb] of Object.entries(b.byRequest)) {
      const cur = byReqPeak.get(reqId) ?? 0;
      if ((rb.requestsPerSec ?? 0) > cur) byReqPeak.set(reqId, rb.requestsPerSec);
    }
  }

  for (const ep of report.endpoints || []) {
    const maxRps = byReqPeak.get(ep.requestId) ?? ep.maxRequestsPerSec ?? 0;
    rows.push(
      [
        ep.name,
        ep.method,
        ep.path,
        ep.totalRequests,
        ep.requestsPerSec.toFixed(2),
        maxRps,
        ep.errorRatePct.toFixed(2),
        ep.errorCount,
        ep.avgMs,
        ep.minMs,
        ep.maxMs,
        ep.p90Ms,
        ep.p95Ms,
        ep.p99Ms,
        ep.bytesReceived,
      ]
        .map(csvEscape)
        .join(',')
    );
  }

  return rows.join('\r\n');
}

/**
 * Exports 1-second time-series performance buckets as an RFC 4180 CSV string.
 */
export function exportPerformanceTimeSeriesCsv(report: PerformanceRunReport): string {
  const headers = [
    'Elapsed (s)',
    'Timestamp (ISO)',
    'Virtual Users',
    'Total Requests',
    'Requests/sec',
    'Error Count',
    'Error Rate (%)',
    'Avg (ms)',
    'Min (ms)',
    'Max (ms)',
    'P90 (ms)',
    'P95 (ms)',
    'P99 (ms)',
  ];

  const rows: string[] = [headers.map(csvEscape).join(',')];
  for (const b of report.timeSeries || []) {
    rows.push(
      [
        b.second,
        new Date(b.timestampMs).toISOString(),
        b.virtualUsers,
        b.totalRequests,
        b.requestsPerSec,
        b.errorCount,
        b.errorRatePct.toFixed(2),
        b.avgMs,
        b.minMs,
        b.maxMs,
        b.p90Ms,
        b.p95Ms,
        b.p99Ms,
      ]
        .map(csvEscape)
        .join(',')
    );
  }

  return rows.join('\r\n');
}

/**
 * Serializes a PerformanceRunReport into a clean JSON export (excluding any raw secret environment dumps).
 */
export function exportPerformanceReportJson(report: PerformanceRunReport): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      generator: 'AirREST Performance Runner',
      report,
    },
    null,
    2
  );
}

/**
 * Builds a completely self-contained, zero-CDN interactive HTML report with
 * multi-axis SVG time-series chart, SLA thresholds, optional baseline comparison,
 * request filter, endpoint breakdown table, and error samples.
 */
export function exportPerformanceReportHtml(
  report: PerformanceRunReport,
  baselineReport?: PerformanceRunReport | null
): string {
  const title = escapeHtml(report.title || 'AirREST Performance Report');
  const startedStr = new Date(report.startedAt).toLocaleString();
  const durationSec = (report.durationMs / 1000).toFixed(1);
  const embeddedReportJson = safeJsonEmbed(report);
  const embeddedBaselineJson = baselineReport ? safeJsonEmbed(baselineReport) : 'null';

  const slaBadgeHtml = report.slaResult
    ? report.slaResult.status === 'passed'
      ? '<span class="badge badge-pass">SLA PASSED (' +
        report.slaResult.passedCount +
        '/' +
        report.slaResult.totalCount +
        ')</span>'
      : '<span class="badge badge-fail">SLA FAILED (' +
        report.slaResult.failedCount +
        '/' +
        report.slaResult.totalCount +
        ')</span>'
    : '';

  const statusLabel = report.autoAborted ? 'STOPPED (AUTO-ABORTED)' : report.status.toUpperCase();

  const slaSectionHtml = report.slaResult
    ? `<div class="card">
        <div class="toolbar" style="margin-bottom:8px;">
          <strong>SLA Threshold Rules (${report.slaResult.passedCount}/${report.slaResult.totalCount} Passed)</strong>
          ${
            report.slaResult.autoAborted && report.slaResult.autoAbortedReason
              ? `<span style="color:var(--rose);font-size:12px;">${escapeHtml(report.slaResult.autoAbortedReason)}</span>`
              : ''
          }
        </div>
        <table>
          <thead>
            <tr>
              <th>Target</th>
              <th>Rule</th>
              <th class="num">Actual</th>
              <th class="num">Status</th>
            </tr>
          </thead>
          <tbody>
            ${report.slaResult.results
              .map(
                (r) => `<tr>
                  <td class="name-col">${escapeHtml(r.targetLabel)}</td>
                  <td>${escapeHtml(formatThresholdRuleExpression(r))}</td>
                  <td class="num">${r.notEvaluated ? '-' : r.actual}</td>
                  <td class="num" style="font-weight:700;color:${
                    r.notEvaluated ? 'var(--amber)' : r.passed ? 'var(--emerald)' : 'var(--rose)'
                  }">${
                    r.notEvaluated ? 'NOT EVALUATED' : r.passed ? 'PASSED' : r.triggeredAbort ? 'ABORTED' : 'FAILED'
                  }</td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>`
    : '';

  let comparisonPayload: Record<string, string> | null = null;
  let comparisonBannerHtml = '';
  if (baselineReport) {
    const comp = computePerformanceComparison(report, baselineReport);
    comparisonPayload = {
      totalRequests: formatDeltaCompact(comp.kpis.totalRequests, 0),
      requestsPerSec: formatDeltaCompact(comp.kpis.requestsPerSec, 2),
      maxRequestsPerSec: formatDeltaCompact(comp.kpis.maxRequestsPerSec, 0),
      avgMs: formatDeltaCompact(comp.kpis.avgMs, 0, 'ms'),
      p90Ms: formatDeltaCompact(comp.kpis.p90Ms, 0, 'ms'),
      p95Ms: formatDeltaCompact(comp.kpis.p95Ms, 0, 'ms'),
      p99Ms: formatDeltaCompact(comp.kpis.p99Ms, 0, 'ms'),
      errorRatePct: formatDeltaCompact(comp.kpis.errorRatePct, 2, '%'),
      totalDir: comp.kpis.totalRequests.direction,
      rpsDir: comp.kpis.requestsPerSec.direction,
      maxRpsDir: comp.kpis.maxRequestsPerSec.direction,
      avgDir: comp.kpis.avgMs.direction,
      p90Dir: comp.kpis.p90Ms.direction,
      p95Dir: comp.kpis.p95Ms.direction,
      p99Dir: comp.kpis.p99Ms.direction,
      errDir: comp.kpis.errorRatePct.direction,
    };
    comparisonBannerHtml = `<div class="compare-banner">
      Comparing against baseline: <strong>${escapeHtml(baselineReport.title)}</strong>
      &bull; ${escapeHtml(new Date(baselineReport.startedAt).toLocaleString())}
      &bull; ${baselineReport.configSnapshot.loadProfile.virtualUsers} VUs
    </div>`;
  }
  const embeddedCompareJson = comparisonPayload ? safeJsonEmbed(comparisonPayload) : 'null';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} — AirREST Performance Report</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #09090b;
      --card: #18181b;
      --elem: #27272a;
      --border: #27272a;
      --text: #f4f4f5;
      --muted: #a1a1aa;
      --accent: #38bdf8;
      --amber: #f59e0b;
      --rose: #f43f5e;
      --emerald: #10b981;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      font-size: 13px;
      line-height: 1.5;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    .header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 20px;
    }
    .title { font-size: 20px; font-weight: 700; margin: 0; }
    .meta { color: var(--muted); font-size: 12px; margin-top: 4px; }
    .badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      background: rgba(56, 189, 248, 0.14);
      color: var(--accent);
      border: 1px solid rgba(56, 189, 248, 0.3);
      margin-left: 6px;
    }
    .badge-pass { background: rgba(16, 185, 129, 0.14); color: var(--emerald); border-color: rgba(16, 185, 129, 0.35); }
    .badge-fail { background: rgba(244, 63, 94, 0.14); color: var(--rose); border-color: rgba(244, 63, 94, 0.35); }
    .compare-banner {
      background: rgba(56, 189, 248, 0.08);
      border: 1px solid rgba(56, 189, 248, 0.25);
      border-radius: 10px;
      padding: 10px 14px;
      margin-bottom: 16px;
      font-size: 12px;
      color: var(--text);
    }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(145px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }
    .kpi {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px 14px;
    }
    .kpi-label { font-size: 11px; color: var(--muted); margin-bottom: 4px; }
    .kpi-value { font-size: 20px; font-weight: 700; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .kpi-sub { font-size: 10px; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin-top: 3px; }
    .delta-good { color: var(--emerald); }
    .delta-bad { color: var(--rose); }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 20px;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
    }
    select {
      background: var(--elem);
      color: var(--text);
      border: 1px solid #3f3f46;
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 12px;
    }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th {
      text-align: left;
      color: var(--muted);
      font-weight: 600;
      padding: 10px 8px;
      border-bottom: 1px solid var(--border);
    }
    td {
      padding: 10px 8px;
      border-bottom: 1px solid rgba(39, 39, 42, 0.7);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    td.name-col { font-family: inherit; font-weight: 500; }
    .num { text-align: right; }
    .method {
      display: inline-block;
      font-family: ui-monospace, monospace;
      font-size: 10px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(56, 189, 248, 0.14);
      color: var(--accent);
      margin-right: 6px;
    }
    .legend { display: flex; flex-wrap: wrap; gap: 16px; justify-content: flex-end; font-size: 11px; color: var(--muted); margin-top: 8px; }
    .legend-item { display: inline-flex; align-items: center; gap: 6px; }
    .swatch { width: 12px; height: 2px; display: inline-block; }
    .err-card { border-left: 3px solid var(--rose); padding: 10px 12px; background: rgba(244, 63, 94, 0.06); border-radius: 6px; margin-bottom: 8px; }
    pre { white-space: pre-wrap; word-break: break-word; background: #09090b; padding: 8px; border-radius: 6px; font-size: 11px; color: #d4d4d8; margin: 6px 0 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div>
        <h1 class="title">${title}</h1>
        <div class="meta">
          Started ${escapeHtml(startedStr)} &bull; Duration ${escapeHtml(durationSec)}s &bull;
          Profile: ${escapeHtml(report.configSnapshot.loadProfile.profile)} (${report.configSnapshot.loadProfile.virtualUsers} VUs) &bull;
          Engine: ${escapeHtml(report.engineMode)}
        </div>
      </div>
      <div>
        ${slaBadgeHtml}
        <span class="badge">${escapeHtml(statusLabel)}</span>
      </div>
    </div>

    ${comparisonBannerHtml}
    ${slaSectionHtml}

    <div class="kpi-grid" id="kpiGrid"></div>

    <div class="card">
      <div class="toolbar">
        <strong>Traffic &amp; Latency Over Time</strong>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <select id="reqFilter"></select>
          <select id="metricSelect">
            <option value="avgMs">Avg. response time</option>
            <option value="p90Ms">P90 response time</option>
            <option value="p95Ms">P95 response time</option>
            <option value="p99Ms">P99 response time</option>
            <option value="maxMs">Max response time</option>
            <option value="minMs">Min response time</option>
          </select>
        </div>
      </div>
      <div style="position:relative;">
        <svg id="chartSvg" viewBox="0 0 1000 280" style="width:100%;height:280px;display:block;"></svg>
      </div>
      <div class="legend">
        <span class="legend-item"><span class="swatch" style="background:var(--amber)"></span>Requests/s</span>
        <span class="legend-item"><span class="swatch" style="background:var(--accent)"></span><span id="latLegend">Avg. response</span></span>
        <span class="legend-item"><span class="swatch" style="background:var(--rose)"></span>Error rate %</span>
        <span class="legend-item"><span class="swatch" style="background:#71717a"></span>Virtual users</span>
        ${baselineReport ? '<span class="legend-item"><span class="swatch" style="border-top:2px dashed #a1a1aa;height:0;"></span>Baseline (dashed)</span>' : ''}
      </div>
    </div>

    <div class="card">
      <strong style="display:block;margin-bottom:10px;">Performance details for total duration</strong>
      <div style="overflow-x:auto;">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Request</th>
              <th class="num">Total</th>
              <th class="num">Req/s</th>
              <th class="num">Max Req/s</th>
              <th class="num">Error %</th>
              <th class="num">Avg (ms)</th>
              <th class="num">Min (ms)</th>
              <th class="num">Max (ms)</th>
              <th class="num">90th (ms)</th>
              <th class="num">95th (ms)</th>
              <th class="num">99th (ms)</th>
            </tr>
          </thead>
          <tbody id="endpointsBody"></tbody>
        </table>
      </div>
    </div>

    <div class="card" id="errorsSection" style="display:none;">
      <strong style="display:block;margin-bottom:10px;">Error Samples</strong>
      <div id="errorsList"></div>
    </div>
  </div>

  <script>
    (function () {
      const report = ${embeddedReportJson};
      const baseline = ${embeddedBaselineJson};
      const cmp = ${embeddedCompareJson};
      const kpiGrid = document.getElementById('kpiGrid');
      const s = report.summary;
      let overallMaxRps = s.maxRequestsPerSec || 0;
      let overallPeakTs = null;
      const epMaxMap = {};
      (report.endpoints || []).forEach(ep => {
        if (typeof ep.maxRequestsPerSec === 'number' && ep.maxRequestsPerSec > 0) {
          epMaxMap[ep.requestId] = ep.maxRequestsPerSec;
        }
      });
      (report.timeSeries || []).forEach(b => {
        if (b.requestsPerSec > overallMaxRps) {
          overallMaxRps = b.requestsPerSec;
          overallPeakTs = b.timestampMs;
        } else if (b.requestsPerSec > 0 && b.requestsPerSec === overallMaxRps && overallPeakTs === null) {
          overallPeakTs = b.timestampMs;
        }
        if (b.byRequest) {
          Object.keys(b.byRequest).forEach(reqId => {
            const val = b.byRequest[reqId].requestsPerSec || 0;
            if (val > (epMaxMap[reqId] || 0)) epMaxMap[reqId] = val;
          });
        }
      });
      const peakTimeStr = overallPeakTs !== null
        ? new Date(overallPeakTs).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
        : '';
      function deltaCls(dir) {
        if (dir === 'improved') return 'delta-good';
        if (dir === 'regressed') return 'delta-bad';
        return '';
      }
      const kpis = [
        ['Total requests sent', s.totalRequests.toLocaleString(), cmp ? cmp.totalRequests : '', cmp ? cmp.totalDir : 'neutral'],
        ['Requests/second', s.requestsPerSec.toFixed(2), cmp ? cmp.requestsPerSec : '', cmp ? cmp.rpsDir : 'neutral'],
        ['Max Req/s', overallMaxRps.toLocaleString(), cmp ? cmp.maxRequestsPerSec : (peakTimeStr ? 'at ' + peakTimeStr : ''), cmp ? cmp.maxRpsDir : 'neutral'],
        ['Avg. response time', s.avgMs + ' ms', cmp ? cmp.avgMs : '', cmp ? cmp.avgDir : 'neutral'],
        ['P90', s.p90Ms + ' ms', cmp ? cmp.p90Ms : '', cmp ? cmp.p90Dir : 'neutral'],
        ['P95', s.p95Ms + ' ms', cmp ? cmp.p95Ms : '', cmp ? cmp.p95Dir : 'neutral'],
        ['P99', s.p99Ms + ' ms', cmp ? cmp.p99Ms : '', cmp ? cmp.p99Dir : 'neutral'],
        ['Error rate', s.errorRatePct.toFixed(2) + '%', cmp ? cmp.errorRatePct : '', cmp ? cmp.errDir : 'neutral']
      ];
      kpiGrid.innerHTML = kpis.map(([l, v, sub, dir]) =>
        '<div class="kpi"><div class="kpi-label">' + l + '</div><div class="kpi-value">' + v + '</div>' +
        (sub ? '<div class="kpi-sub ' + deltaCls(dir) + '">' + sub + '</div>' : '') + '</div>'
      ).join('');

      const reqFilter = document.getElementById('reqFilter');
      const metricSelect = document.getElementById('metricSelect');
      const chartSvg = document.getElementById('chartSvg');
      const latLegend = document.getElementById('latLegend');

      reqFilter.innerHTML = '<option value="all">All requests</option>' +
        (report.endpoints || []).map(ep => '<option value="' + ep.requestId.replace(/"/g, '&quot;') + '">' + ep.method + ' ' + ep.name.replace(/</g, '&lt;') + '</option>').join('');

      function drawChart() {
        const series = report.timeSeries || [];
        const baseSeries = baseline && baseline.timeSeries ? baseline.timeSeries : [];
        const filterId = reqFilter.value;
        const metricKey = metricSelect.value;
        latLegend.textContent = metricSelect.options[metricSelect.selectedIndex].text;

        const W = 1000, H = 280;
        const PAD = { left: 48, right: 110, top: 20, bottom: 28 };
        const plotW = W - PAD.left - PAD.right;
        const plotH = H - PAD.top - PAD.bottom;

        if (!series.length && !baseSeries.length) {
          chartSvg.innerHTML = '<text x="500" y="140" text-anchor="middle" fill="#a1a1aa">No time-series buckets recorded</text>';
          return;
        }

        const curMap = {};
        const baseMap = {};
        let maxSec = 0;
        series.forEach((b, i) => {
          const sec = typeof b.second === 'number' ? b.second : i;
          curMap[sec] = b;
          if (sec > maxSec) maxSec = sec;
        });
        baseSeries.forEach((b, i) => {
          const sec = typeof b.second === 'number' ? b.second : i;
          baseMap[sec] = b;
          if (sec > maxSec) maxSec = sec;
        });

        const points = [];
        for (let sIdx = 0; sIdx <= maxSec; sIdx++) {
          const b = curMap[sIdx];
          const bb = baseMap[sIdx];
          const src = b ? (filterId !== 'all' && b.byRequest && b.byRequest[filterId] ? b.byRequest[filterId] : (filterId === 'all' ? b : null)) : null;
          const bsrc = bb ? (filterId !== 'all' && bb.byRequest && bb.byRequest[filterId] ? bb.byRequest[filterId] : (filterId === 'all' ? bb : null)) : null;
          points.push({
            sec: sIdx,
            hasCur: Boolean(b),
            hasBase: Boolean(bb),
            rps: src ? src.requestsPerSec : 0,
            lat: src ? src[metricKey] : 0,
            err: src ? src.errorRatePct : 0,
            vu: b ? (b.virtualUsers || 0) : 0,
            brps: bsrc ? bsrc.requestsPerSec : 0,
            blat: bsrc ? bsrc[metricKey] : 0,
            berr: bsrc ? bsrc.errorRatePct : 0
          });
        }

        const maxRps = Math.max(1, ...points.map(p => Math.max(p.rps, p.brps)));
        const maxLat = Math.max(10, ...points.map(p => Math.max(p.lat, p.blat)));
        const maxVu = Math.max(1, ...points.map(p => p.vu));

        const xOf = (i) => PAD.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
        const yErr = (v) => PAD.top + plotH - (Math.min(100, Math.max(0, v)) / 100) * plotH;
        const yLat = (v) => PAD.top + plotH - (v / maxLat) * plotH;
        const yRps = (v) => PAD.top + plotH - (v / maxRps) * plotH;
        const yVu = (v) => PAD.top + plotH - (v / maxVu) * plotH;

        const line = (getter, filterFn) => points
          .map((p, i) => ({ p, i }))
          .filter(x => !filterFn || filterFn(x.p))
          .map(x => xOf(x.i).toFixed(1) + ',' + getter(x.p).toFixed(1))
          .join(' ');
        const gridLines = [0, 0.25, 0.5, 0.75, 1].map(f => {
          const y = PAD.top + plotH * (1 - f);
          return '<line x1="' + PAD.left + '" y1="' + y + '" x2="' + (W - PAD.right) + '" y2="' + y + '" stroke="#27272a" stroke-dasharray="2 3" />' +
            '<text x="' + (PAD.left - 8) + '" y="' + (y + 4) + '" text-anchor="end" font-size="10" fill="#f43f5e">' + Math.round(f * 100) + '%</text>' +
            '<text x="' + (W - PAD.right + 8) + '" y="' + (y + 4) + '" text-anchor="start" font-size="10" fill="#38bdf8">' + Math.round(f * maxLat) + ' ms</text>' +
            '<text x="' + (W - PAD.right + 62) + '" y="' + (y + 4) + '" text-anchor="start" font-size="10" fill="#f59e0b">' + Math.round(f * maxRps) + '/s</text>';
        }).join('');

        let svgContent = gridLines;
        if (baseline) {
          svgContent +=
            '<polyline points="' + line(p => yLat(p.blat), p => p.hasBase) + '" fill="none" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="5 4" opacity="0.55" />' +
            '<polyline points="' + line(p => yRps(p.brps), p => p.hasBase) + '" fill="none" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="5 4" opacity="0.55" />';
        }
        svgContent +=
          '<polyline points="' + line(p => yVu(p.vu), p => p.hasCur) + '" fill="none" stroke="#71717a" stroke-width="1.5" opacity="0.55" />' +
          '<polyline points="' + line(p => yErr(p.err), p => p.hasCur) + '" fill="none" stroke="#f43f5e" stroke-width="2" />' +
          '<polyline points="' + line(p => yLat(p.lat), p => p.hasCur) + '" fill="none" stroke="#38bdf8" stroke-width="2" />' +
          '<polyline points="' + line(p => yRps(p.rps), p => p.hasCur) + '" fill="none" stroke="#f59e0b" stroke-width="2" />';
        chartSvg.innerHTML = svgContent;
      }

      reqFilter.addEventListener('change', drawChart);
      metricSelect.addEventListener('change', drawChart);
      drawChart();

      const tbody = document.getElementById('endpointsBody');
      tbody.innerHTML = (report.endpoints || []).map((ep, i) => {
        const errAlpha = ep.errorRatePct > 0 ? Math.min(0.6, 0.15 + ep.errorRatePct / 100) : 0;
        const errStyle = errAlpha > 0 ? 'background:rgba(244,63,94,' + errAlpha.toFixed(2) + ');color:#fecdd3;font-weight:700;' : '';
        return '<tr>' +
          '<td>' + (i + 1) + '</td>' +
          '<td class="name-col"><span class="method">' + ep.method + '</span>' + ep.name.replace(/</g, '&lt;') + '</td>' +
          '<td class="num">' + ep.totalRequests.toLocaleString() + '</td>' +
          '<td class="num">' + ep.requestsPerSec.toFixed(2) + '</td>' +
          '<td class="num">' + (epMaxMap[ep.requestId] || 0).toLocaleString() + '</td>' +
          '<td class="num" style="' + errStyle + '">' + ep.errorRatePct.toFixed(2) + '%</td>' +
          '<td class="num">' + ep.avgMs + '</td>' +
          '<td class="num">' + ep.minMs + '</td>' +
          '<td class="num">' + ep.maxMs + '</td>' +
          '<td class="num">' + ep.p90Ms + '</td>' +
          '<td class="num">' + ep.p95Ms + '</td>' +
          '<td class="num">' + ep.p99Ms + '</td>' +
        '</tr>';
      }).join('');

      if ((report.errorSamples || []).length > 0) {
        document.getElementById('errorsSection').style.display = 'block';
        document.getElementById('errorsList').innerHTML = report.errorSamples.map(err =>
          '<div class="err-card"><div><strong>' + err.method + ' ' + err.requestName.replace(/</g, '&lt;') + '</strong> &mdash; ' +
          (err.status > 0 ? 'HTTP ' + err.status + ' ' : '') + err.message.replace(/</g, '&lt;') + ' (' + err.timeMs + ' ms)</div>' +
          (err.responseSnippet ? '<pre>' + err.responseSnippet.replace(/</g, '&lt;') + '</pre>' : '') +
          '</div>'
        ).join('');
      }
    })();
  </script>
</body>
</html>`;
}
