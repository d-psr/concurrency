import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';

export function buildSummary(data, { caseSlug, scenarioName }) {
  if (!caseSlug) {
    throw new Error('buildSummary: caseSlug이 필수다');
  }
  // if (!scenarioName) {
  //   throw new Error('buildSummary: scenarioName이 필수다');
  // }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  // const base = `k6/${caseSlug}/result/${scenarioName}`;
  const base = `k6/${caseSlug}/result`;
  const json = JSON.stringify(data, null, 2);

  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    [`${base}/summary-${ts}.json`]: json,
    [`${base}/summary-latest.json`]: json,
  };
}
