// Beta 分布数值工具：全部使用双精度手算，不引入第三方依赖。
// 供 Beta-Binomial 共轭后验、阈值后验概率、可信区间与蒙特卡洛排序使用。

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

export function logGamma(z) {
  if (!(z > 0) || !Number.isFinite(z)) throw new Error('logGamma 只接受正数');
  if (z < 0.5) {
    // 反射公式：Gamma(z) Gamma(1-z) = pi / sin(pi z)
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  z -= 1;
  let x = LANCZOS[0];
  for (let i = 1; i < LANCZOS.length; i += 1) x += LANCZOS[i] / (z + i);
  const t = z + LANCZOS.length - 1.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

export function logBeta(a, b) {
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

// 连分式（Lentz 算法），对应 Numerical Recipes betacf。
function betaContinuedFraction(a, b, x) {
  const fpmin = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < fpmin) d = fpmin;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return h;
}

// 正则不完全 Beta 函数 I_x(a, b)，即 Beta(a,b) 的累积分布。
export function betaCdf(x, a, b) {
  if (!(a > 0) || !(b > 0)) throw new Error('Beta 参数必须为正');
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const logTail = a * Math.log(x) + b * Math.log(1 - x) - logBeta(a, b);
  let value;
  if (x < (a + 1) / (a + b + 2)) {
    value = Math.exp(logTail - Math.log(a)) * betaContinuedFraction(a, b, x);
  } else {
    value = 1 - Math.exp(logTail - Math.log(b)) * betaContinuedFraction(b, a, 1 - x);
  }
  return Math.min(1, Math.max(0, value));
}

// 二分反解 Beta 分位数；边界参数下依然稳定，不依赖梯度。
export function betaQuantile(p, a, b) {
  if (!(p > 0 && p < 1)) throw new Error('分位点必须在 (0,1) 内');
  let low = 0;
  let high = 1;
  for (let i = 0; i < 80; i += 1) {
    const mid = (low + high) / 2;
    if (betaCdf(mid, a, b) < p) low = mid;
    else high = mid;
    if (high - low < 1e-12) break;
  }
  return (low + high) / 2;
}

export function betaMean(a, b) {
  return a / (a + b);
}

export function betaVariance(a, b) {
  const n = a + b;
  return (a * b) / (n * n * (n + 1));
}

// 共轭更新：Beta(alpha,beta) + 二项计数 (success, attempts) => Beta 后验参数。
export function conjugateUpdate(alpha, beta, success, attempts) {
  if (!(alpha > 0) || !(beta > 0)) throw new Error('先验参数必须为正');
  if (!Number.isSafeInteger(success) || !Number.isSafeInteger(attempts)) {
    throw new Error('成功数与尝试次数必须为安全整数');
  }
  if (success < 0 || attempts < 0 || success > attempts) {
    throw new Error('需满足 0 <= success <= attempts');
  }
  return { alpha: alpha + success, beta: beta + attempts - success };
}

// 确定性伪随机流（mulberry32），保证排序不确定性可复算。
export function createRng(seed) {
  let state = Number(seed) >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Marsaglia-Tsang Gamma 抽样；shape < 1 时用加一技巧。
function gammaSample(rng, shape) {
  if (shape < 1) {
    const base = gammaSample(rng, shape + 1);
    return base * rng() ** (1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x;
    do {
      const u1 = Math.max(rng(), 1e-12);
      const u2 = Math.max(rng(), 1e-12);
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    } while (!(x > -1 / c));
    const v = (1 + c * x) ** 3;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function betaSample(rng, a, b) {
  const x = gammaSample(rng, a);
  const y = gammaSample(rng, b);
  return x / (x + y);
}
