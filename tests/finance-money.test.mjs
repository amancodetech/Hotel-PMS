import { test, expect } from '@jest/globals';
import {
  assertCurrency,
  parsePositiveMoney,
  planPostingLines,
  roundPosting,
} from '@hotel/backend';

/**
 * Independent reference for HALF_UP rounding of a positive decimal string to
 * two places, kept deliberately small and separate from the production
 * implementation: it only inspects the third decimal digit and returns minor
 * units (1/100).
 */
function referenceMinor(amount) {
  const [integerPart, fractionRaw = ''] = amount.split('.');
  const fraction = `${fractionRaw}000`.slice(0, 3);
  let minor = BigInt(integerPart) * 100n + BigInt(fraction.slice(0, 2));
  if (Number(fraction[2]) >= 5) minor += 1n;
  return minor;
}

function fixedSeedRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

function randomScaled(random, min, max) {
  return BigInt(Math.floor(min + random() * (max - min + 1)));
}

function scaledToAmount(scaled) {
  const integerPart = scaled / 1000000n;
  const fraction = (scaled % 1000000n).toString().padStart(6, '0');
  return `${integerPart}.${fraction}`;
}

function splitScaled(random, total, parts) {
  const result = [];
  let remaining = total;
  for (let index = 0; index < parts - 1; index += 1) {
    const max = remaining - BigInt(parts - index - 1) * 10000n;
    const part = randomScaled(random, 10000, Number(max));
    result.push(part);
    remaining -= part;
  }
  result.push(remaining);
  return result;
}

test('P08-01 money parsing rejects floats, excess precision and non-positive amounts (AT-A02)', () => {
  for (const value of ['1e3', '12.1234567', '-1', '0', '0.000', '', 'NaN']) {
    expect(() => parsePositiveMoney(value, 'amount')).toThrow();
  }
  expect(() => parsePositiveMoney(100, 'amount')).toThrow();
  expect(() => assertCurrency('EUR')).toThrow();
  expect(parsePositiveMoney('0.000001', 'amount')).toBe(1n);
  expect(assertCurrency('USD')).toBe('USD');
});

test('P08-01 posting rounds HALF_UP per line to two decimals', () => {
  expect(roundPosting(1005000n)).toBe(1010000n);
  expect(roundPosting(1004999n)).toBe(1000000n);
  expect(roundPosting(1010000n)).toBe(1010000n);
});

test('P08-01 a balanced journal posts without a rounding line', () => {
  const plan = planPostingLines([
    { account_code: 'FOLIO_GUEST', side: 'DEBIT', amount: 1005000n },
    { account_code: 'REVENUE_ROOM', side: 'CREDIT', amount: 1000000n },
    { account_code: 'REVENUE_OTHER', side: 'CREDIT', amount: 5000n },
  ]);
  expect(plan.total_debit).toBe('1.01');
  expect(plan.total_credit).toBe('1.01');
  expect(plan.lines).toHaveLength(3);
});

test('P08-01 per-line rounding residual is declared as a ROUNDING_DIFFERENCE line', () => {
  const plan = planPostingLines([
    { account_code: 'FOLIO_GUEST', side: 'DEBIT', amount: 14000n },
    { account_code: 'REVENUE_ROOM', side: 'CREDIT', amount: 6000n },
    { account_code: 'REVENUE_OTHER', side: 'CREDIT', amount: 8000n },
  ]);
  expect(plan.total_debit).toBe(plan.total_credit);
  expect(plan.total_debit).toBe('0.02');
  const rounding = plan.lines.filter(
    (line) => line.account_code === 'ROUNDING_DIFFERENCE',
  );
  expect(rounding).toHaveLength(1);
  expect(rounding[0].debit).toBe('0.01');
  expect(rounding[0].credit).toBe('0');
});

test('P08-01 an amount that rounds to zero is rejected instead of dropped', () => {
  expect(() =>
    planPostingLines([
      { account_code: 'FOLIO_GUEST', side: 'DEBIT', amount: 4000n },
      { account_code: 'REVENUE_ROOM', side: 'CREDIT', amount: 4000n },
    ]),
  ).toThrow(/FRACTION_NOT_SUPPORTED|rounds_to_zero/);
});

test('P08-01 property: per-line HALF_UP then sum matches an independent reference', () => {
  const random = fixedSeedRandom(20260916);
  for (let iteration = 0; iteration < 300; iteration += 1) {
    const total = randomScaled(random, 10000, 1000000000);
    const debitParts = splitScaled(random, total, 1 + Math.floor(random() * 3));
    const creditParts = splitScaled(
      random,
      total,
      1 + Math.floor(random() * 3),
    );
    const lines = [
      ...debitParts.map((scaled) => ({
        account_code: 'FOLIO_GUEST',
        side: 'DEBIT',
        amount: scaled,
      })),
      ...creditParts.map((scaled) => ({
        account_code: 'REVENUE_ROOM',
        side: 'CREDIT',
        amount: scaled,
      })),
    ];
    const plan = planPostingLines(lines);
    let referenceDebit = 0n;
    let referenceCredit = 0n;
    for (const part of debitParts)
      referenceDebit += referenceMinor(scaledToAmount(part));
    for (const part of creditParts)
      referenceCredit += referenceMinor(scaledToAmount(part));
    const residual =
      referenceDebit > referenceCredit
        ? referenceDebit - referenceCredit
        : referenceCredit - referenceDebit;
    expect(plan.total_debit).toBe(plan.total_credit);
    const parsedTotal = referenceMinor(plan.total_debit);
    const larger =
      referenceDebit > referenceCredit ? referenceDebit : referenceCredit;
    expect(parsedTotal).toBe(larger);
    expect(plan.lines.length).toBe(
      debitParts.length + creditParts.length + (residual === 0n ? 0 : 1),
    );
  }
});
