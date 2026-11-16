// Beta / Beta-Binomial 数值函数，全部基于 Node 内置 Math 实现，无第三方依赖。
// 所有函数对有限正数参数负责；调用方需先完成参数校验。

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
];
// g=7 的 Lanczos 展开：系数 1..g 进入求和，末位系数仅用于该阶公式的余项约定，不参与求和
const LANCZOS_ORDER = 7;

export function logGamma(z) {
  if (z <= 0) throw new Error('logGamma 仅接受正数参数');
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  z -= 1;
  let x = LANCZOS[0];
  for (let i = 1; i <= LANCZOS_ORDER; i += 1) x += LANCZOS[i] / (z + i);
  const t = z + LANCZOS_ORDER + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

export function logBeta(a, b) {
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

// 连分式（Lentz 方法），Numerical Recipes 口径
function betaContinuedFraction(a, b, x) {
  const MAX_ITERATIONS = 200;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITERATIONS; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }
  return h;
}

// 正则化不完全 Beta 函数 I_x(a,b) = P(Beta(a,b) <= x)
export function betaIncomplete(x, a, b) {
  if (!(a > 0 && b > 0)) throw new Error('Beta 参数必须为正数');
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b)
    + a * Math.log(x) + b * Math.log1p(-x)
  );
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betaContinuedFraction(a, b, x)) / a;
  }
  return 1 - (bt * betaContinuedFraction(b, a, 1 - x)) / b;}

// Beta 分布密度
export function betaDensity(x, a, b) {
  if (x <= 0 || x >= 1) return 0;
  return Math.exp(-logBeta(a, b) + (a - 1) * Math.log(x) + (b - 1) * Math.log1p(-x));
}

// 逆正则化不完全 Beta：二分括号保护的牛顿迭代
export function betaInverse(probability, a, b) {
  if (!(probability >= 0 && probability <= 1)) throw new Error('概率必须在 [0,1]');
  if (probability === 0) return 0;
  if (probability === 1) return 1;
  const mean = a / (a + b);
  const variance = (a * b) / ((a + b) ** 2 * (a + b + 1));
  let x = Math.min(0.999999, Math.max(1e-12, mean + (probability - 0.5) * Math.sqrt(12 * variance)));
  let lo = 0;
  let hi = 1;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    if (x <= lo || x >= hi) x = (lo + hi) / 2;
    const cdf = betaIncomplete(x, a, b);
    const error = cdf - probability;
    if (Math.abs(error) <= 1e-12 || (hi - lo) <= 1e-14) return x;
    if (error < 0) lo = x;
    else hi = x;
    const density = betaDensity(x, a, b);
    if (density > 1e-300) {
      const next = x - error / density;
      if (next > lo && next < hi) x = next;
      else x = (lo + hi) / 2;
    } else {
      x = (lo + hi) / 2;
    }
  }
  return x;
}

export function betaMean(a, b) {
  return a / (a + b);
}

export function betaVariance(a, b) {
  return (a * b) / ((a + b) ** 2 * (a + b + 1));
}

// Beta-Binomial(n, a, b) 在 k 处的质量函数，取对数空间计算
export function logBetaBinomialPmf(k, n, a, b) {
  if (k < 0 || k > n) return -Infinity;
  const logChoose = logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
  return logChoose + logBeta(k + a, n - k + b) - logBeta(a, b);
}

export function betaBinomialPmf(k, n, a, b) {
  return Math.exp(logBetaBinomialPmf(k, n, a, b));
}

// ---- 随机抽样：splitmix64 确定性随机数 + Gamma/Beta 抽样 ----

export function createRng(seed) {
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('随机种子必须是非负安全整数');
  let state = BigInt(seed);
  const MASK = (1n << 64n) - 1n;
  return function next() {
    state = (state + 0x9e3779b97f4a7c15n) & MASK;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
    z ^= z >> 31n;
    return Number(z >> 11n) / 2 ** 53;
  };
}

// Marsaglia-Tsang Gamma 抽样；shape < 1 时用 X=Gamma(shape+1)*U^(1/shape)
export function gammaSample(rng, shape) {
  if (shape <= 0) throw new Error('Gamma shape 必须为正数');
  if (shape < 1) {
    const base = gammaSample(rng, shape + 1);
    return base * rng() ** (1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x;
    let v;
    do {
      const standard = Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
      x = standard;
      v = (1 + c * x) ** 3;
    } while (v <= 0);
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x ** 2 + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function betaSample(rng, a, b) {
  const x = gammaSample(rng, a);
  const y = gammaSample(rng, b);
  return x / (x + y);
}
