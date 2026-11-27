import type { FunctionalRunReport, FunctionalStepResult } from '../types/api';

function escapeHtml(raw: unknown): string {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeXml(raw: unknown): string {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function exportFunctionalReportJson(report: FunctionalRunReport): string {
  return JSON.stringify(report, null, 2);
}

function formatStepStatusLabel(status: FunctionalStepResult['status']): string {
  if (status === 'passed') return 'PASSED';
  if (status === 'warning') return 'WARNING';
  if (status === 'failed') return 'FAILED';
  if (status === 'error') return 'ERROR';
  return 'SKIPPED';
}

export function exportFunctionalReportHtml(report: FunctionalRunReport): string {
  const startedLabel = new Date(report.startedAt).toISOString();
  const iterationsMap = new Map<number, FunctionalStepResult[]>();
  for (const step of report.steps) {
    const arr = iterationsMap.get(step.iteration) || [];
    arr.push(step);
    iterationsMap.set(step.iteration, arr);
  }

  const iterationBlocks = Array.from(iterationsMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([iterNum, steps]) => {
      const rows = steps
        .map((step) => {
          const badgeClass =
            step.status === 'passed'
              ? 'badge-pass'
              : step.status === 'warning'
                ? 'badge-warn'
                : step.status === 'skipped'
                  ? 'badge-skip'
                  : 'badge-fail';
          const testsHtml =
            step.testResults.length > 0
              ? `<ul class="tests-list">${step.testResults
                  .map(
                    (t) =>
                      `<li class="${t.passed ? 'test-pass' : 'test-fail'}"><strong>${
                        t.passed ? 'PASS' : 'FAIL'
                      }</strong> ${escapeHtml(t.name)}${
                        t.error ? `<div class="err-detail">${escapeHtml(t.error)}</div>` : ''
                      }</li>`
                  )
                  .join('')}</ul>`
              : '';
          const stepErr = step.scriptError || step.errorMessage;
          const errHtml = stepErr
            ? `<div class="err-detail">${escapeHtml(stepErr)}</div>`
            : step.warningMessage
              ? `<div class="warn-detail">${escapeHtml(step.warningMessage)}</div>`
              : '';
          return `
            <tr>
              <td><span class="method">${escapeHtml(step.method)}</span></td>
              <td>
                <div class="req-name">${escapeHtml(step.name)}</div>
                <div class="req-url">${escapeHtml(step.url)}</div>
                ${errHtml}
                ${testsHtml}
              </td>
              <td><span class="badge ${badgeClass}">${formatStepStatusLabel(step.status)}</span></td>
              <td>${step.httpStatus > 0 ? `${step.httpStatus} ${escapeHtml(step.statusText)}` : escapeHtml(step.statusText || '-')}</td>
              <td>${step.timeMs} ms</td>
              <td>${step.testsPassed}/${step.testsPassed + step.testsFailed}</td>
            </tr>`;
        })
        .join('\n');

      return `
        <section class="iter-section">
          <h3>Iteration ${iterNum}</h3>
          <table>
            <thead>
              <tr>
                <th>Method</th>
                <th>Request &amp; Assertions</th>
                <th>Outcome</th>
                <th>HTTP</th>
                <th>Latency</th>
                <th>Tests</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </section>`;
    })
    .join('\n');

  const overallPassed = report.requestsErrored === 0 && report.testsFailed === 0 && report.requestsFailed === 0;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(report.title)} — Functional Report</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 24px; line-height: 1.5; }
    .container { max-width: 1120px; margin: 0 auto; }
    header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; border-bottom: 1px solid #334155; padding-bottom: 16px; margin-bottom: 20px; }
    h1 { margin: 0; font-size: 20px; color: #f8fafc; }
    .meta { font-size: 12px; color: #94a3b8; margin-top: 4px; }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .kpi { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 12px 14px; }
    .kpi-label { font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.04em; }
    .kpi-val { font-size: 20px; font-weight: 700; margin-top: 4px; color: #f8fafc; }
    .iter-section { margin-bottom: 24px; background: #1e293b; border: 1px solid #334155; border-radius: 10px; overflow: hidden; }
    .iter-section h3 { margin: 0; padding: 10px 14px; background: #0b1220; border-bottom: 1px solid #334155; font-size: 13px; color: #cbd5e1; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #293548; vertical-align: top; }
    th { font-size: 11px; color: #94a3b8; text-transform: uppercase; }
    .method { font-family: ui-monospace, monospace; font-weight: 700; color: #38bdf8; }
    .req-name { font-weight: 600; color: #f1f5f9; }
    .req-url { font-family: ui-monospace, monospace; font-size: 11px; color: #94a3b8; word-break: break-all; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 10px; font-weight: 700; }
    .badge-pass { background: rgba(16, 185, 129, 0.16); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.35); }
    .badge-warn { background: rgba(245, 158, 11, 0.16); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.35); }
    .badge-fail { background: rgba(244, 63, 94, 0.16); color: #fb7185; border: 1px solid rgba(244, 63, 94, 0.35); }
    .badge-skip { background: rgba(148, 163, 184, 0.16); color: #cbd5e1; border: 1px solid rgba(148, 163, 184, 0.35); }
    .tests-list { margin: 8px 0 0; padding-left: 16px; }
    .test-pass { color: #34d399; margin-bottom: 2px; }
    .test-fail { color: #fb7185; margin-bottom: 4px; }
    .err-detail { margin-top: 4px; padding: 6px 8px; border-radius: 6px; background: rgba(244, 63, 94, 0.12); color: #fda4af; font-family: ui-monospace, monospace; font-size: 11px; white-space: pre-wrap; }
    .warn-detail { margin-top: 4px; padding: 6px 8px; border-radius: 6px; background: rgba(245, 158, 11, 0.12); color: #fcd34d; font-family: ui-monospace, monospace; font-size: 11px; white-space: pre-wrap; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>${escapeHtml(report.title)}</h1>
        <div class="meta">Started: ${escapeHtml(startedLabel)} • Duration: ${(report.durationMs / 1000).toFixed(2)}s • Status: ${escapeHtml(report.status)}</div>
      </div>
      <span class="badge ${overallPassed ? 'badge-pass' : 'badge-fail'}">${overallPassed ? 'ALL PASSED' : 'FAILURES DETECTED'}</span>
    </header>
    <div class="kpis">
      <div class="kpi"><div class="kpi-label">Iterations</div><div class="kpi-val">${report.completedIterations} / ${report.plannedIterations}</div></div>
      <div class="kpi"><div class="kpi-label">Requests Executed</div><div class="kpi-val">${report.totalRequestsExecuted}</div></div>
      <div class="kpi"><div class="kpi-label">Tests Passed</div><div class="kpi-val">${report.testsPassed}</div></div>
      <div class="kpi"><div class="kpi-label">Tests Failed</div><div class="kpi-val">${report.testsFailed}</div></div>
      <div class="kpi"><div class="kpi-label">Avg Latency</div><div class="kpi-val">${report.avgResponseTimeMs} ms</div></div>
    </div>
    ${iterationBlocks || '<p>No request steps executed.</p>'}
  </div>
</body>
</html>`;
}

export function exportFunctionalReportJunitXml(report: FunctionalRunReport): string {
  const iterationsMap = new Map<number, FunctionalStepResult[]>();
  for (const step of report.steps) {
    const arr = iterationsMap.get(step.iteration) || [];
    arr.push(step);
    iterationsMap.set(step.iteration, arr);
  }

  let totalTests = 0;
  let totalFailures = 0;
  let totalErrors = 0;
  let totalSkipped = 0;

  const suiteXmlBlocks: string[] = [];

  for (const [iterNum, steps] of Array.from(iterationsMap.entries()).sort((a, b) => a[0] - b[0])) {
    let suiteTests = 0;
    let suiteFailures = 0;
    let suiteErrors = 0;
    let suiteSkipped = 0;
    let suiteTimeSec = 0;
    const cases: string[] = [];

    for (const step of steps) {
      const classname = `${step.method} ${step.name}`;
      const stepTimeSec = (step.timeMs || 0) / 1000;
      suiteTimeSec += stepTimeSec;

      if (step.status === 'skipped') {
        suiteTests += 1;
        suiteSkipped += 1;
        cases.push(
          `    <testcase classname="${escapeXml(classname)}" name="${escapeXml(step.name)}" time="0"><skipped message="${escapeXml(step.errorMessage || 'Skipped')}" /></testcase>`
        );
        continue;
      }

      if (step.status === 'error' && step.testResults.length === 0) {
        suiteTests += 1;
        suiteErrors += 1;
        const msg = step.scriptError || step.errorMessage || 'Request execution error';
        cases.push(
          `    <testcase classname="${escapeXml(classname)}" name="${escapeXml(step.name)}" time="${stepTimeSec.toFixed(3)}"><error message="${escapeXml(msg)}">${escapeXml(msg)}</error></testcase>`
        );
        continue;
      }

      if (step.status === 'failed' && step.testResults.length === 0) {
        suiteTests += 1;
        suiteFailures += 1;
        const msg = step.errorMessage || `HTTP ${step.httpStatus || 0} ${step.statusText || 'Request failed'}`.trim();
        cases.push(
          `    <testcase classname="${escapeXml(classname)}" name="${escapeXml(`${step.name} (${step.httpStatus || 0})`)}" time="${stepTimeSec.toFixed(3)}"><failure message="${escapeXml(msg)}">${escapeXml(msg)}</failure></testcase>`
        );
        continue;
      }

      if (step.testResults.length === 0) {
        suiteTests += 1;
        cases.push(
          `    <testcase classname="${escapeXml(classname)}" name="${escapeXml(`${step.name} (${step.httpStatus || 0})` )}" time="${stepTimeSec.toFixed(3)}" />`
        );
        continue;
      }

      for (const t of step.testResults) {
        suiteTests += 1;
        const tTime = ((t.durationMs ?? 0) / 1000).toFixed(3);
        if (t.passed) {
          cases.push(
            `    <testcase classname="${escapeXml(classname)}" name="${escapeXml(t.name)}" time="${tTime}" />`
          );
        } else {
          suiteFailures += 1;
          const msg = t.error || 'Assertion failed';
          cases.push(
            `    <testcase classname="${escapeXml(classname)}" name="${escapeXml(t.name)}" time="${tTime}"><failure message="${escapeXml(msg)}">${escapeXml(msg)}</failure></testcase>`
          );
        }
      }

      if (step.status === 'error') {
        suiteTests += 1;
        suiteErrors += 1;
        const msg = step.scriptError || step.errorMessage || 'Script error';
        cases.push(
          `    <testcase classname="${escapeXml(classname)}" name="${escapeXml(`${step.name} (script/request error)`)}" time="${stepTimeSec.toFixed(3)}"><error message="${escapeXml(msg)}">${escapeXml(msg)}</error></testcase>`
        );
      }
    }

    totalTests += suiteTests;
    totalFailures += suiteFailures;
    totalErrors += suiteErrors;
    totalSkipped += suiteSkipped;

    suiteXmlBlocks.push(
      `  <testsuite name="${escapeXml(`${report.title} - Iteration ${iterNum}`)}" tests="${suiteTests}" failures="${suiteFailures}" errors="${suiteErrors}" skipped="${suiteSkipped}" time="${suiteTimeSec.toFixed(3)}" timestamp="${escapeXml(new Date(report.startedAt).toISOString())}">\n${cases.join('\n')}\n  </testsuite>`
    );
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${escapeXml(report.title)}" tests="${totalTests}" failures="${totalFailures}" errors="${totalErrors}" skipped="${totalSkipped}" time="${((report.durationMs || 0) / 1000).toFixed(3)}">\n${suiteXmlBlocks.join('\n')}\n</testsuites>\n`;
}
