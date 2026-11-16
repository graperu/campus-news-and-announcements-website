import { publishMetrics } from './publish-metrics.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
const url = process.env.ARTICLE_URL;
if (!url) throw new Error('Set ARTICLE_URL to a public article API URL on CloudFront');
const count = Number(process.env.REQUESTS || 200);
if (!Number.isInteger(count) || count < 1 || count > 1000)
  throw new Error('REQUESTS must be 1-1000');
const samples = [];
async function request(address, phase, index) {
  const started = performance.now();
  try {
    const response = await fetch(address, { signal: AbortSignal.timeout(15000) });
    await response.arrayBuffer();
    const sample = {
      phase,
      index,
      time: new Date().toISOString(),
      status: response.status,
      latencyMs: performance.now() - started,
      cache: response.headers.get('x-cache'),
      age: response.headers.get('age'),
      requestId: response.headers.get('x-request-id'),
    };
    samples.push(sample);
    return sample;
  } catch (error) {
    const sample = {
      phase,
      index,
      time: new Date().toISOString(),
      status: 0,
      latencyMs: performance.now() - started,
      error: error.name,
    };
    samples.push(sample);
    return sample;
  }
}
const startedAt = new Date().toISOString();
await request(url, 'warmup', 0);
for (let i = 0; i < count; i++) await request(url, 'cached', i);
for (let i = 0; i < count; i++) {
  const baseline = new URL(url);
  baseline.searchParams.set('baseline', `${Date.now()}-${i}`);
  await request(baseline, 'uncached-baseline', i);
}
function summarize(phase) {
  const group = samples.filter((s) => s.phase === phase),
    durations = group.map((s) => s.latencyMs).sort((a, b) => a - b),
    hasCdn = group.some((s) => s.cache !== null && s.cache !== undefined);
  return {
    samples: group.length,
    errorRate: group.filter((s) => s.status < 200 || s.status >= 400).length / group.length,
    p95Ms: durations[Math.ceil(group.length * 0.95) - 1],
    cacheHits: hasCdn
      ? group.filter((s) => /hit from cloudfront/i.test(s.cache || '')).length
      : null,
    uniqueOriginRequestIds: new Set(group.map((s) => s.requestId).filter(Boolean)).size,
  };
}
await mkdir('output/evidence', { recursive: true });
const result = {
  startedAt,
  finishedAt: new Date().toISOString(),
  url,
  workload: {
    requestsPerPhase: count,
    concurrency: 1,
    warmupRequests: 1,
    dataset: 'one article',
    baseline: 'unique query string per request; cache policy must include all query strings',
  },
  cached: summarize('cached'),
  baseline: summarize('uncached-baseline'),
  samples,
};
await writeFile('output/evidence/cache.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify({ cached: result.cached, baseline: result.baseline }));

await publishMetrics({ PublicReadP95Ms: result.cached.p95Ms });
