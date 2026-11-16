import { publishMetrics } from './publish-metrics.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
const { ARTICLE_URL, EXPECTED_VERSION, PUBLISHED_AT } = process.env;
if (
  !ARTICLE_URL ||
  !EXPECTED_VERSION ||
  !PUBLISHED_AT ||
  !Number.isFinite(Date.parse(PUBLISHED_AT))
)
  throw new Error(
    'Set ARTICLE_URL, EXPECTED_VERSION, PUBLISHED_AT (ISO UTC from publication history).',
  );
const start = Date.parse(PUBLISHED_AT),
  samples = [];
let lagMs = null;
while (Date.now() - start <= 60000) {
  const r = await fetch(ARTICLE_URL, { signal: AbortSignal.timeout(10000) });
  const body = await r.json();
  const sample = {
    time: new Date().toISOString(),
    status: r.status,
    version: body.version_id || null,
    cache: r.headers.get('x-cache'),
    requestId: r.headers.get('x-request-id'),
  };
  samples.push(sample);
  if (r.ok && body.version_id === EXPECTED_VERSION) {
    lagMs = Date.now() - start;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
await mkdir('storage/reports/evidence', { recursive: true });
await writeFile(
  'storage/reports/evidence/freshness.json',
  JSON.stringify(
    {
      url: ARTICLE_URL,
      expectedVersion: EXPECTED_VERSION,
      publishedAt: PUBLISHED_AT,
      lagMs,
      passed: lagMs !== null && lagMs <= 60000,
      samples,
    },
    null,
    2,
  ),
);
console.log({ lagMs, passed: lagMs !== null && lagMs <= 60000 });
if (lagMs === null) process.exitCode = 1;

if (lagMs !== null) await publishMetrics({ PublicationFreshnessLagMs: lagMs });
