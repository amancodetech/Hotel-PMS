import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const directory = process.argv[2];
if (!directory)
  throw Error('Provide the original performance evidence directory');
const rawBytes = readFileSync(directory + '/performance.json');
const raw = JSON.parse(rawBytes);
const percentile = (values, q) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
const groups = new Map();
for (const sample of raw.samples) {
  const key = JSON.stringify([sample.label, sample.phase, sample.size]);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(sample);
}
const summary = [...groups].map(([key, samples]) => {
  const [label, phase, size] = JSON.parse(key),
    times = samples.map((x) => x.api_ms).filter((x) => x !== null);
  return {
    label,
    phase,
    size,
    samples: samples.length,
    p50_ms: percentile(times, 0.5),
    p95_ms: percentile(times, 0.95),
    failures: samples.filter((x) => x.failure).length,
    undetermined: samples.filter((x) => x.result === 'UNDETERMINED').length,
    service_query_counts: samples.map((x) => x.service_query_count),
    all_outcomes_included: true,
  };
});
writeFileSync(
  directory + '/phase-summary.json',
  JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      raw_sha256: createHash('sha256').update(rawBytes).digest('hex'),
      source_sha256: createHash('sha256')
        .update(readFileSync(directory + '/source.mjs'))
        .digest('hex'),
      cold_definition: raw.cold_definition,
      query_count_method: raw.query_count_method,
      summary,
    },
    null,
    2,
  ),
);
