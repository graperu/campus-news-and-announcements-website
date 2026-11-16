import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
export async function publishMetrics(values) {
  if (process.env.PUBLISH_METRICS !== 'true') return;
  const deployment = process.env.DEPLOYMENT_NAME;
  if (!deployment) throw new Error('Set DEPLOYMENT_NAME to Terraform dashboard/prefix');
  const metrics = Object.entries(values)
    .filter(([, value]) => Number.isFinite(value))
    .map(([name, value]) => ({
      MetricName: name,
      Value: value,
      Unit: 'Milliseconds',
      Dimensions: [{ Name: 'Deployment', Value: deployment }],
    }));
  if (metrics.length)
    await promisify(execFile)('aws', [
      'cloudwatch',
      'put-metric-data',
      '--namespace',
      'CampusNews',
      '--metric-data',
      JSON.stringify(metrics),
    ]);
}
