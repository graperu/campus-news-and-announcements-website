import { mkdir, writeFile } from 'node:fs/promises';
const region = 'ap-southeast-1',
  hours = 730,
  proof = [];
async function catalog(service) {
  const url = `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/${service}/current/${region}/index.json`;
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${service}: ${r.status}`);
  return { url, data: await r.json() };
}
function rate(c, predicate) {
  const products = Object.values(c.data.products).filter(predicate);
  if (products.length !== 1) throw new Error(`Expected one SKU, got ${products.length}`);
  const p = products[0],
    term = Object.values(c.data.terms.OnDemand[p.sku] || {})[0],
    price = Object.values(term.priceDimensions)[0];
  proof.push({
    url: c.url,
    sku: p.sku,
    attributes: p.attributes,
    unit: price.unit,
    usd: Number(price.pricePerUnit.USD),
  });
  return Number(price.pricePerUnit.USD);
}
const [ecs, elb, rds] = await Promise.all(['AmazonECS', 'AWSELB', 'AmazonRDS'].map(catalog));
const cpu = rate(ecs, (p) => p.attributes.usagetype === 'APS1-Fargate-vCPU-Hours:perCPU'),
  memory = rate(ecs, (p) => p.attributes.usagetype === 'APS1-Fargate-GB-Hours');
const alb = rate(
  elb,
  (p) =>
    p.productFamily === 'Load Balancer-Application' &&
    p.attributes.locationType === 'AWS Region' &&
    p.attributes.usagetype === 'APS1-LoadBalancerUsage',
);
const lcu = rate(
  elb,
  (p) =>
    p.productFamily === 'Load Balancer-Application' &&
    p.attributes.locationType === 'AWS Region' &&
    p.attributes.usagetype === 'APS1-LCUUsage',
);
const database = rate(
  rds,
  (p) =>
    p.attributes.usagetype === 'APS1-InstanceUsage:db.t4g.micro' &&
    p.attributes.databaseEngine === 'PostgreSQL' &&
    p.attributes.deploymentOption === 'Single-AZ',
);
const storage = rate(
  rds,
  (p) =>
    p.attributes.usagetype === 'APS1-RDS:GP3-Storage' &&
    p.attributes.databaseEngine === 'PostgreSQL' &&
    p.attributes.deploymentOption === 'Single-AZ',
);
const items = [
  { name: 'Fargate 0.25 vCPU + 0.5 GB, one task', usd: hours * (cpu * 0.25 + memory * 0.5) },
  { name: 'ALB 730 hours', usd: hours * alb },
  { name: 'ALB assumed average 1 LCU for 730 hours', usd: hours * lcu },
  { name: 'RDS PostgreSQL db.t4g.micro Single-AZ', usd: hours * database },
  { name: 'RDS gp3 20 GB', usd: storage * 20 },
];
const subtotal = items.reduce((sum, i) => sum + i.usd, 0),
  reserve = 30;
const result = {
  retrievedAt: new Date().toISOString(),
  region,
  workload: {
    hours,
    taskCount: 1,
    vcpu: 0.25,
    memoryGb: 0.5,
    databaseGb: 20,
    s3Gb: 1,
    publicRequests: 100000,
    egressGb: 10,
    logsGb: 1,
    backupDays: 7,
    averageLcu: 1,
  },
  items,
  verifiedRateSubtotalUsd: subtotal,
  planningReserveUsd: reserve,
  planningTotalUsd: subtotal + reserve,
  reserveExplanation:
    'Planning allowance, not quoted rates: public task IPv4, S3, ECR, CloudFront requests/egress, logs, dashboard, additional metrics, Secrets Manager, backup excess, Cognito/SNS and incidental usage. No free tier or credits deducted. Reprice these items in AWS Pricing Calculator before deployment.',
  proof,
};
await mkdir('docs/evidence', { recursive: true });
await writeFile('docs/evidence/cost-estimate.json', JSON.stringify(result, null, 2));
console.log(
  JSON.stringify({
    region,
    verifiedRateSubtotalUsd: subtotal,
    planningReserveUsd: reserve,
    planningTotalUsd: subtotal + reserve,
  }),
);
