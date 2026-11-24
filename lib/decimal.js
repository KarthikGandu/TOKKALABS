// Fixed-point helper: quantities are BigInt "units" with 9 decimal places, so
// shares/tokens never suffer float drift. Pure functions, no state.
const SCALE = 9;
const ONE = 10n ** BigInt(SCALE);

function parse(input) {
  const s = typeof input === 'number' ? String(input) : input;
  if (typeof s !== 'string' || !/^\d+(\.\d+)?$/.test(s.trim()))
    throw new Error(`invalid quantity "${input}": must be a positive decimal number`);
  const [int, frac = ''] = s.trim().split('.');
  if (frac.length > SCALE) throw new Error(`invalid quantity "${input}": more than ${SCALE} decimal places`);
  const units = BigInt(int) * ONE + BigInt(frac.padEnd(SCALE, '0'));
  if (units <= 0n) throw new Error(`invalid quantity "${input}": must be greater than zero`);
  return units;
}

function format(units) {
  const int = units / ONE;
  const frac = (units % ONE).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return frac ? `${int}.${frac}` : `${int}`;
}

module.exports = { SCALE, ONE, parse, format };
