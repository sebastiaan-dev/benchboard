export interface Statistics {
	n: number;
	mean: number;
	stddev: number | null;
	median: number;
	min: number;
	max: number;
	q1: number;
	q3: number;
	p95: number;
	cv: number | null;
}

/** Linear-interpolated quantile (Hyperfine/NumPy "linear" method) over sorted values. */
export function quantile(sorted: ArrayLike<number>, p: number): number {
	const index = (sorted.length - 1) * p;
	const lo = Math.floor(index);
	const hi = Math.ceil(index);
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}

export function statistics(times: readonly number[]): Statistics {
	const sorted = Float64Array.from(times).sort();
	// Welford's online variance avoids cancellation for tightly clustered timings.
	let mean = 0;
	let m2 = 0;
	times.forEach((time, i) => {
		const delta = time - mean;
		mean += delta / (i + 1);
		m2 += delta * (time - mean);
	});
	const stddev = times.length > 1 ? Math.sqrt(Math.max(0, m2 / (times.length - 1))) : null;
	return {
		n: times.length,
		mean,
		stddev,
		median: quantile(sorted, 0.5),
		min: sorted[0],
		max: sorted[sorted.length - 1],
		q1: quantile(sorted, 0.25),
		q3: quantile(sorted, 0.75),
		p95: quantile(sorted, 0.95),
		cv: mean > 0 && stddev !== null ? stddev / mean : null,
	};
}

export type Statistic = "mean" | "median";

/** Deterministic PRNG (mulberry32) so reports are reproducible across requests. */
export function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function seedFrom(text: string): number {
	let hash = 2166136261;
	for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
	return hash >>> 0;
}

/** In-place quickselect of the k-th smallest element. */
function select(values: Float64Array, k: number): number {
	let lo = 0;
	let hi = values.length - 1;
	while (lo < hi) {
		const pivot = values[(lo + hi) >>> 1];
		let i = lo;
		let j = hi;
		while (i <= j) {
			while (values[i] < pivot) i++;
			while (values[j] > pivot) j--;
			if (i <= j) {
				const swap = values[i];
				values[i] = values[j];
				values[j] = swap;
				i++;
				j--;
			}
		}
		if (k <= j) hi = j;
		else if (k >= i) lo = i;
		else break;
	}
	return values[k];
}

function medianOf(values: Float64Array): number {
	const n = values.length;
	const upper = select(values, n >> 1);
	if (n % 2) return upper;
	// After selecting the upper middle, the lower middle is the maximum of the left partition.
	let lower = -Infinity;
	for (let i = 0; i < n >> 1; i++) if (values[i] > lower) lower = values[i];
	return (lower + upper) / 2;
}

function resampledStatistic(source: readonly number[], buffer: Float64Array, next: () => number, statistic: Statistic): number {
	const n = source.length;
	if (statistic === "mean") {
		let sum = 0;
		for (let i = 0; i < n; i++) sum += source[(next() * n) | 0];
		return sum / n;
	}
	for (let i = 0; i < n; i++) buffer[i] = source[(next() * n) | 0];
	return medianOf(buffer);
}

export interface RatioInterval {
	ratio: number;
	low: number;
	high: number;
	resamples: number;
}

/**
 * Percentile-bootstrap 95% interval for statistic(candidate) / statistic(baseline).
 * Samples are resampled independently; the work budget bounds cost for very large exports.
 */
export function bootstrapRatio(
	candidate: readonly number[], baseline: readonly number[], statistic: Statistic, seed: number, confidence = 0.95,
): RatioInterval | null {
	const point = (values: readonly number[]) => statistic === "mean"
		? values.reduce((sum, value) => sum + value, 0) / values.length
		: medianOf(Float64Array.from(values));
	const base = point(baseline);
	const value = point(candidate);
	if (!(base > 0) || !(value > 0)) return null;
	const ratio = value / base;
	if (candidate.length < 2 || baseline.length < 2) return { ratio, low: ratio, high: ratio, resamples: 0 };
	const resamples = Math.max(200, Math.min(2000, Math.floor(4_000_000 / (candidate.length + baseline.length))));
	const next = random(seed);
	const a = new Float64Array(candidate.length);
	const b = new Float64Array(baseline.length);
	const ratios = new Float64Array(resamples);
	for (let r = 0; r < resamples; r++) {
		const denominator = resampledStatistic(baseline, b, next, statistic);
		ratios[r] = denominator > 0 ? resampledStatistic(candidate, a, next, statistic) / denominator : Infinity;
	}
	ratios.sort();
	const tail = (1 - confidence) / 2;
	return { ratio, low: quantile(ratios, tail), high: quantile(ratios, 1 - tail), resamples };
}
