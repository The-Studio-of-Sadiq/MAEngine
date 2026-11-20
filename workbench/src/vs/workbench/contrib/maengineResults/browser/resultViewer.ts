/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MAEngine contributors. All rights reserved.
 *  Licensed under the MIT license.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType, getWindow } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';

export interface IResultField {
	readonly label: string;
	readonly unit: string;
	readonly values: readonly number[];
}

export interface IResultViewMode {
	readonly mode: number;
	readonly frequency_Hz: number;
	readonly displacement: readonly number[];
}

export interface IResultViewData {
	readonly schema: number;
	readonly analysisType?: string;
	readonly units?: { readonly length?: string };
	readonly positions: readonly number[];
	readonly triangles: readonly number[];
	readonly displacement: readonly number[] | null;
	readonly modes?: readonly IResultViewMode[];
	readonly fields: Readonly<Record<string, IResultField>>;
}

export type DeformationScaleMode = 'auto' | 'undeformed' | 'true' | 'custom';

export interface IResultViewerFieldInfo {
	readonly id: string;
	readonly label: string;
	readonly unit: string;
}

export interface IResultViewerState {
	readonly fieldId: string;
	readonly fieldLabel: string;
	readonly unit: string;
	readonly min: number;
	readonly max: number;
	readonly activeScale: number;
	readonly autoScale: number;
	readonly scaleMode: DeformationScaleMode;
	readonly hasDisplacement: boolean;
	readonly edgesVisible: boolean;
	readonly animating: boolean;
}

interface IParsedField {
	readonly id: string;
	readonly label: string;
	readonly unit: string;
	readonly values: Float32Array;
	readonly min: number;
	readonly max: number;
}

interface IPickHit {
	readonly triIndex: number;
	readonly u: number;
	readonly v: number;
	readonly t: number;
}

const COLORMAP_STOPS: readonly (readonly [number, number, number])[] = [
	[0.10, 0.28, 0.82],
	[0.05, 0.72, 0.85],
	[0.16, 0.78, 0.34],
	[0.96, 0.86, 0.14],
	[0.85, 0.14, 0.14],
];

const SURFACE_VERT_SHADER = `
attribute vec3 aPosition;
attribute vec3 aNormal;
attribute vec3 aColor;

uniform mat4 uMvp;
uniform mat4 uView;

varying vec3 vColor;
varying vec3 vNormal;

void main() {
	vColor = aColor;
	vNormal = normalize((uView * vec4(aNormal, 0.0)).xyz);
	gl_Position = uMvp * vec4(aPosition, 1.0);
}
`;

const SURFACE_FRAG_SHADER = `
precision mediump float;

varying vec3 vColor;
varying vec3 vNormal;

void main() {
	vec3 n = normalize(vNormal);
	if (!gl_FrontFacing) {
		n = -n;
	}
	vec3 keyDir = normalize(vec3(0.4, 0.6, 0.8));
	vec3 fillDir = normalize(vec3(-0.5, -0.3, 0.5));
	float keyDiff = max(dot(n, keyDir), 0.0);
	float fillDiff = max(dot(n, fillDir), 0.0);
	float shade = clamp(0.48 + 0.40 * keyDiff + 0.15 * fillDiff, 0.0, 1.0);
	gl_FragColor = vec4(vColor * shade, 1.0);
}
`;

const EDGE_VERT_SHADER = `
attribute vec3 aPosition;
uniform mat4 uMvp;

void main() {
	gl_Position = uMvp * vec4(aPosition, 1.0);
}
`;

const EDGE_FRAG_SHADER = `
precision mediump float;
uniform vec4 uEdgeColor;

void main() {
	gl_FragColor = uEdgeColor;
}
`;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumberArray(value: unknown): value is readonly number[] {
	if (!Array.isArray(value)) {
		return false;
	}
	for (let i = 0; i < value.length; i++) {
		if (typeof value[i] !== 'number' || !Number.isFinite(value[i])) {
			return false;
		}
	}
	return true;
}

function isValidTriangleArray(value: unknown, nodeCount: number): value is readonly number[] {
	if (!Array.isArray(value) || value.length < 3 || value.length % 3 !== 0) {
		return false;
	}
	for (let i = 0; i < value.length; i++) {
		const idx = value[i];
		if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= nodeCount) {
			return false;
		}
	}
	return true;
}

/**
 * Validates and normalizes parsed JSON from a solver `*_view.json` file.
 */
export function parseResultViewData(raw: unknown): IResultViewData | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	if (!isFiniteNumberArray(raw.positions) || raw.positions.length < 9 || raw.positions.length % 3 !== 0) {
		return undefined;
	}
	const nodeCount = raw.positions.length / 3;

	if (!isValidTriangleArray(raw.triangles, nodeCount)) {
		return undefined;
	}
	const triangles = raw.triangles;

	const analysisType = typeof raw.analysisType === 'string' ? raw.analysisType : undefined;

	const parsedModes: IResultViewMode[] = [];
	if (Array.isArray(raw.modes)) {
		for (const entry of raw.modes) {
			if (
				isRecord(entry) &&
				typeof entry.mode === 'number' &&
				Number.isInteger(entry.mode) &&
				entry.mode > 0 &&
				typeof entry.frequency_Hz === 'number' &&
				Number.isFinite(entry.frequency_Hz) &&
				isFiniteNumberArray(entry.displacement) &&
				entry.displacement.length === raw.positions.length
			) {
				parsedModes.push({
					mode: entry.mode,
					frequency_Hz: entry.frequency_Hz,
					displacement: entry.displacement,
				});
			}
		}
	}

	let displacement: readonly number[] | null = null;
	if (raw.displacement !== null && raw.displacement !== undefined) {
		if (isFiniteNumberArray(raw.displacement) && raw.displacement.length === raw.positions.length) {
			displacement = raw.displacement;
		}
	}
	if (displacement === null && parsedModes.length > 0) {
		displacement = parsedModes[0].displacement;
	}

	if (!isRecord(raw.fields)) {
		return undefined;
	}

	const fields: Record<string, IResultField> = {};
	let validFieldCount = 0;
	for (const [key, entry] of Object.entries(raw.fields)) {
		if (key === '__proto__' || !isRecord(entry)) {
			continue;
		}
		if (!isFiniteNumberArray(entry.values) || entry.values.length !== nodeCount) {
			continue;
		}
		const label = typeof entry.label === 'string' && entry.label.trim().length > 0 ? entry.label : key;
		const unit = typeof entry.unit === 'string' ? entry.unit : '';
		Object.defineProperty(fields, key, {
			value: { label, unit, values: entry.values },
			enumerable: true,
			configurable: true,
			writable: true,
		});
		validFieldCount++;
	}

	if (validFieldCount === 0) {
		return undefined;
	}

	let units: { readonly length?: string } | undefined;
	if (isRecord(raw.units) && typeof raw.units.length === 'string') {
		units = { length: raw.units.length };
	}

	return {
		schema: typeof raw.schema === 'number' ? raw.schema : 1,
		analysisType,
		units,
		positions: raw.positions,
		triangles,
		displacement,
		modes: parsedModes.length > 0 ? parsedModes : undefined,
		fields,
	};
}

/**
 * Formats a scalar contour value to 4 significant digits while keeping zero clean.
 */
export function formatResultNumber(value: number): string {
	if (!Number.isFinite(value) || value === 0) {
		return '0';
	}
	const abs = Math.abs(value);
	if (abs >= 1e4 || abs < 1e-3) {
		return value.toExponential(3);
	}
	const rounded = Number(value.toPrecision(4));
	return rounded === 0 ? '0' : String(rounded);
}

/**
 * Formats a deformation exaggeration factor cleanly (e.g. `1.2e+03`, `1`, `0`).
 */
export function formatScaleFactor(scale: number): string {
	if (!Number.isFinite(scale) || scale === 0) {
		return '0';
	}
	if (Math.abs(scale - 1) < 1e-9) {
		return '1';
	}
	const abs = Math.abs(scale);
	if (abs >= 1e3 || abs < 1e-2) {
		const exp = scale.toExponential(1);
		const parts = exp.split('e');
		if (parts.length === 2) {
			const sign = parts[1].startsWith('-') ? '-' : '+';
			const digits = parts[1].replace(/^[+-]/, '').padStart(2, '0');
			return `${parts[0]}e${sign}${digits}`;
		}
		return exp;
	}
	const rounded = Number(scale.toPrecision(3));
	return rounded === 0 ? '0' : String(rounded);
}

function sampleColormap(t: number, out: Float32Array, offset: number): void {
	const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
	const scaled = clamped * (COLORMAP_STOPS.length - 1);
	const i0 = Math.min(COLORMAP_STOPS.length - 2, Math.floor(scaled));
	const frac = scaled - i0;
	const c0 = COLORMAP_STOPS[i0];
	const c1 = COLORMAP_STOPS[i0 + 1];
	out[offset] = c0[0] + (c1[0] - c0[0]) * frac;
	out[offset + 1] = c0[1] + (c1[1] - c0[1]) * frac;
	out[offset + 2] = c0[2] + (c1[2] - c0[2]) * frac;
}

function parseCssColor(css: string): [number, number, number] | undefined {
	const trimmed = css.trim();
	if (!trimmed) {
		return undefined;
	}
	if (trimmed.startsWith('#')) {
		const hex = trimmed.slice(1);
		if (hex.length === 3 || hex.length === 4) {
			const r = parseInt(hex[0] + hex[0], 16);
			const g = parseInt(hex[1] + hex[1], 16);
			const b = parseInt(hex[2] + hex[2], 16);
			if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
				return [r / 255, g / 255, b / 255];
			}
		} else if (hex.length === 6 || hex.length === 8) {
			const r = parseInt(hex.slice(0, 2), 16);
			const g = parseInt(hex.slice(2, 4), 16);
			const b = parseInt(hex.slice(4, 6), 16);
			if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
				return [r / 255, g / 255, b / 255];
			}
		}
		return undefined;
	}
	const rgbMatch = /^rgba?\(\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)/i.exec(trimmed);
	if (rgbMatch) {
		const r = Number(rgbMatch[1]);
		const g = Number(rgbMatch[2]);
		const b = Number(rgbMatch[3]);
		if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
			return [
				Math.max(0, Math.min(1, r / 255)),
				Math.max(0, Math.min(1, g / 255)),
				Math.max(0, Math.min(1, b / 255)),
			];
		}
	}
	return undefined;
}

function makePerspective(fovYRad: number, aspect: number, near: number, far: number, out: Float32Array): void {
	const f = 1.0 / Math.tan(fovYRad * 0.5);
	const nf = 1.0 / (near - far);
	out.fill(0);
	out[0] = f / Math.max(aspect, 1e-6);
	out[5] = f;
	out[10] = (far + near) * nf;
	out[11] = -1;
	out[14] = 2 * far * near * nf;
}

function makeLookAt(
	ex: number, ey: number, ez: number,
	tx: number, ty: number, tz: number,
	ux: number, uy: number, uz: number,
	out: Float32Array
): void {
	let zx = ex - tx;
	let zy = ey - ty;
	let zz = ez - tz;
	let zLen = Math.hypot(zx, zy, zz);
	if (zLen < 1e-12) {
		zz = 1;
		zLen = 1;
	}
	zx /= zLen;
	zy /= zLen;
	zz /= zLen;

	let xx = uy * zz - uz * zy;
	let xy = uz * zx - ux * zz;
	let xz = ux * zy - uy * zx;
	let xLen = Math.hypot(xx, xy, xz);
	if (xLen < 1e-12) {
		xx = 1;
		xy = 0;
		xz = 0;
		xLen = 1;
	}
	xx /= xLen;
	xy /= xLen;
	xz /= xLen;

	const yx = zy * xz - zz * xy;
	const yy = zz * xx - zx * xz;
	const yz = zx * xy - zy * xx;

	out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
	out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
	out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
	out[12] = -(xx * ex + xy * ey + xz * ez);
	out[13] = -(yx * ex + yy * ey + yz * ez);
	out[14] = -(zx * ex + zy * ey + zz * ez);
	out[15] = 1;
}

function multiplyMat4(a: Float32Array, b: Float32Array, out: Float32Array): void {
	for (let col = 0; col < 4; col++) {
		const b0 = b[col * 4];
		const b1 = b[col * 4 + 1];
		const b2 = b[col * 4 + 2];
		const b3 = b[col * 4 + 3];
		out[col * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
		out[col * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
		out[col * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
		out[col * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
	}
}

/**
 * Flat-array BVH over deformed surface triangles for fast CPU ray-picking.
 */
class TriangleBVH {
	private triIndices = new Uint32Array(0);
	private centroids = new Float32Array(0);
	private bounds = new Float32Array(0);
	private leftOrStart = new Int32Array(0);
	private rightOrCount = new Int32Array(0);
	private nodeCapacity = 0;
	private nodeCount = 0;
	private triCount = 0;
	private readonly stack = new Int32Array(128);

	build(positions: Float32Array, indices: Uint16Array | Uint32Array, triCount: number): void {
		this.triCount = triCount;
		this.nodeCount = 0;
		if (triCount <= 0) {
			return;
		}

		if (this.triIndices.length < triCount) {
			this.triIndices = new Uint32Array(triCount);
			this.centroids = new Float32Array(triCount * 3);
		}
		const initialCap = Math.max(16, Math.ceil(triCount * 0.5) + 64);
		if (this.nodeCapacity < initialCap) {
			this.ensureCapacity(initialCap);
		}

		for (let t = 0; t < triCount; t++) {
			this.triIndices[t] = t;
			const base = t * 3;
			const p0 = indices[base] * 3;
			const p1 = indices[base + 1] * 3;
			const p2 = indices[base + 2] * 3;
			this.centroids[base] = (positions[p0] + positions[p1] + positions[p2]) / 3;
			this.centroids[base + 1] = (positions[p0 + 1] + positions[p1 + 1] + positions[p2 + 1]) / 3;
			this.centroids[base + 2] = (positions[p0 + 2] + positions[p1 + 2] + positions[p2 + 2]) / 3;
		}

		this.buildNode(positions, indices, 0, triCount, 0);
	}

	private ensureCapacity(required: number): void {
		let nextCap = Math.max(16, this.nodeCapacity);
		while (nextCap < required) {
			nextCap *= 2;
		}
		const nextBounds = new Float32Array(nextCap * 6);
		const nextLeft = new Int32Array(nextCap);
		const nextRight = new Int32Array(nextCap);
		if (this.nodeCount > 0) {
			nextBounds.set(this.bounds.subarray(0, this.nodeCount * 6));
			nextLeft.set(this.leftOrStart.subarray(0, this.nodeCount));
			nextRight.set(this.rightOrCount.subarray(0, this.nodeCount));
		}
		this.bounds = nextBounds;
		this.leftOrStart = nextLeft;
		this.rightOrCount = nextRight;
		this.nodeCapacity = nextCap;
	}

	private allocNode(): number {
		if (this.nodeCount >= this.nodeCapacity) {
			this.ensureCapacity(this.nodeCount + 1);
		}
		return this.nodeCount++;
	}

	private buildNode(positions: Float32Array, indices: Uint16Array | Uint32Array, start: number, end: number, depth: number): number {
		const nodeIdx = this.allocNode();
		let minX = Infinity;
		let minY = Infinity;
		let minZ = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		let maxZ = -Infinity;

		let cMinX = Infinity;
		let cMinY = Infinity;
		let cMinZ = Infinity;
		let cMaxX = -Infinity;
		let cMaxY = -Infinity;
		let cMaxZ = -Infinity;

		for (let i = start; i < end; i++) {
			const tri = this.triIndices[i];
			const base = tri * 3;
			for (let k = 0; k < 3; k++) {
				const p = indices[base + k] * 3;
				const x = positions[p];
				const y = positions[p + 1];
				const z = positions[p + 2];
				if (x < minX) { minX = x; }
				if (y < minY) { minY = y; }
				if (z < minZ) { minZ = z; }
				if (x > maxX) { maxX = x; }
				if (y > maxY) { maxY = y; }
				if (z > maxZ) { maxZ = z; }
			}
			const cx = this.centroids[base];
			const cy = this.centroids[base + 1];
			const cz = this.centroids[base + 2];
			if (cx < cMinX) { cMinX = cx; }
			if (cy < cMinY) { cMinY = cy; }
			if (cz < cMinZ) { cMinZ = cz; }
			if (cx > cMaxX) { cMaxX = cx; }
			if (cy > cMaxY) { cMaxY = cy; }
			if (cz > cMaxZ) { cMaxZ = cz; }
		}

		const bOffset = nodeIdx * 6;
		this.bounds[bOffset] = minX;
		this.bounds[bOffset + 1] = minY;
		this.bounds[bOffset + 2] = minZ;
		this.bounds[bOffset + 3] = maxX;
		this.bounds[bOffset + 4] = maxY;
		this.bounds[bOffset + 5] = maxZ;

		const count = end - start;
		if (count <= 8 || depth >= 30) {
			this.leftOrStart[nodeIdx] = start;
			this.rightOrCount[nodeIdx] = count;
			return nodeIdx;
		}

		const extX = cMaxX - cMinX;
		const extY = cMaxY - cMinY;
		const extZ = cMaxZ - cMinZ;
		let axis = 0;
		let split = 0.5 * (cMinX + cMaxX);
		if (extY > extX && extY >= extZ) {
			axis = 1;
			split = 0.5 * (cMinY + cMaxY);
		} else if (extZ > extX && extZ > extY) {
			axis = 2;
			split = 0.5 * (cMinZ + cMaxZ);
		}

		let mid = start;
		if (extX > 1e-12 || extY > 1e-12 || extZ > 1e-12) {
			let i = start;
			let j = end - 1;
			while (i <= j) {
				const c = this.centroids[this.triIndices[i] * 3 + axis];
				if (c < split) {
					i++;
				} else {
					const tmp = this.triIndices[i];
					this.triIndices[i] = this.triIndices[j];
					this.triIndices[j] = tmp;
					j--;
				}
			}
			mid = i;
		}

		if (mid === start || mid === end) {
			mid = (start + end) >>> 1;
		}

		const leftChild = this.buildNode(positions, indices, start, mid, depth + 1);
		const rightChild = this.buildNode(positions, indices, mid, end, depth + 1);
		this.leftOrStart[nodeIdx] = leftChild;
		this.rightOrCount[nodeIdx] = -rightChild;
		return nodeIdx;
	}

	private intersectAabb(
		nodeIdx: number,
		ox: number, oy: number, oz: number,
		invX: number, invY: number, invZ: number,
		maxT: number
	): number {
		const b = nodeIdx * 6;
		const tx0 = (this.bounds[b] - ox) * invX;
		const tx1 = (this.bounds[b + 3] - ox) * invX;
		let tMin = tx0 < tx1 ? tx0 : tx1;
		let tMax = tx0 > tx1 ? tx0 : tx1;

		const ty0 = (this.bounds[b + 1] - oy) * invY;
		const ty1 = (this.bounds[b + 4] - oy) * invY;
		const tyMin = ty0 < ty1 ? ty0 : ty1;
		const tyMax = ty0 > ty1 ? ty0 : ty1;
		if (tyMin > tMin) { tMin = tyMin; }
		if (tyMax < tMax) { tMax = tyMax; }

		const tz0 = (this.bounds[b + 2] - oz) * invZ;
		const tz1 = (this.bounds[b + 5] - oz) * invZ;
		const tzMin = tz0 < tz1 ? tz0 : tz1;
		const tzMax = tz0 > tz1 ? tz0 : tz1;
		if (tzMin > tMin) { tMin = tzMin; }
		if (tzMax < tMax) { tMax = tzMax; }

		if (tMax >= 0 && tMin <= tMax && tMin < maxT) {
			return tMin;
		}
		return Infinity;
	}

	pick(
		positions: Float32Array,
		indices: Uint16Array | Uint32Array,
		ox: number, oy: number, oz: number,
		dx: number, dy: number, dz: number,
		minT: number
	): IPickHit | undefined {
		if (this.triCount <= 0 || this.nodeCount <= 0) {
			return undefined;
		}
		const invX = 1 / (Math.abs(dx) < 1e-30 ? (dx < 0 ? -1e-30 : 1e-30) : dx);
		const invY = 1 / (Math.abs(dy) < 1e-30 ? (dy < 0 ? -1e-30 : 1e-30) : dy);
		const invZ = 1 / (Math.abs(dz) < 1e-30 ? (dz < 0 ? -1e-30 : 1e-30) : dz);

		let closestT = Infinity;
		let bestTri = -1;
		let bestU = 0;
		let bestV = 0;

		if (this.intersectAabb(0, ox, oy, oz, invX, invY, invZ, closestT) === Infinity) {
			return undefined;
		}

		let sp = 0;
		this.stack[sp++] = 0;

		while (sp > 0) {
			const nodeIdx = this.stack[--sp];
			const rightOrCnt = this.rightOrCount[nodeIdx];
			if (rightOrCnt > 0) {
				const start = this.leftOrStart[nodeIdx];
				const end = start + rightOrCnt;
				for (let i = start; i < end; i++) {
					const tri = this.triIndices[i];
					const base = tri * 3;
					const p0 = indices[base] * 3;
					const p1 = indices[base + 1] * 3;
					const p2 = indices[base + 2] * 3;

					const ax = positions[p0];
					const ay = positions[p0 + 1];
					const az = positions[p0 + 2];

					const e1x = positions[p1] - ax;
					const e1y = positions[p1 + 1] - ay;
					const e1z = positions[p1 + 2] - az;

					const e2x = positions[p2] - ax;
					const e2y = positions[p2 + 1] - ay;
					const e2z = positions[p2 + 2] - az;

					const px = dy * e2z - dz * e2y;
					const py = dz * e2x - dx * e2z;
					const pz = dx * e2y - dy * e2x;

					const det = e1x * px + e1y * py + e1z * pz;
					if (Math.abs(det) < 1e-12) {
						continue;
					}
					const invDet = 1 / det;

					const tx = ox - ax;
					const ty = oy - ay;
					const tz = oz - az;

					const u = (tx * px + ty * py + tz * pz) * invDet;
					if (u < 0 || u > 1) {
						continue;
					}

					const qx = ty * e1z - tz * e1y;
					const qy = tz * e1x - tx * e1z;
					const qz = tx * e1y - ty * e1x;

					const v = (dx * qx + dy * qy + dz * qz) * invDet;
					if (v < 0 || u + v > 1) {
						continue;
					}

					const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
					if (t > minT && t < closestT) {
						closestT = t;
						bestTri = tri;
						bestU = u;
						bestV = v;
					}
				}
			} else {
				const left = this.leftOrStart[nodeIdx];
				const right = -rightOrCnt;
				const tLeft = this.intersectAabb(left, ox, oy, oz, invX, invY, invZ, closestT);
				const tRight = this.intersectAabb(right, ox, oy, oz, invX, invY, invZ, closestT);
				if (tLeft < Infinity && tRight < Infinity) {
					if (tLeft < tRight) {
						this.stack[sp++] = right;
						this.stack[sp++] = left;
					} else {
						this.stack[sp++] = left;
						this.stack[sp++] = right;
					}
				} else if (tLeft < Infinity) {
					this.stack[sp++] = left;
				} else if (tRight < Infinity) {
					this.stack[sp++] = right;
				}
			}
		}

		if (bestTri < 0) {
			return undefined;
		}
		return { triIndex: bestTri, u: bestU, v: bestV, t: closestT };
	}
}

interface ICompiledProgram {
	readonly program: WebGLProgram;
	readonly attribs: ReadonlyMap<string, number>;
	readonly uniforms: ReadonlyMap<string, WebGLUniformLocation | null>;
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | undefined {
	const shader = gl.createShader(type);
	if (!shader) {
		return undefined;
	}
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		gl.deleteShader(shader);
		return undefined;
	}
	return shader;
}

function createProgram(
	gl: WebGLRenderingContext,
	vertSrc: string,
	fragSrc: string,
	attribNames: readonly string[],
	uniformNames: readonly string[]
): ICompiledProgram | undefined {
	const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
	const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
	if (!vs || !fs) {
		if (vs) { gl.deleteShader(vs); }
		if (fs) { gl.deleteShader(fs); }
		return undefined;
	}
	const program = gl.createProgram();
	if (!program) {
		gl.deleteShader(vs);
		gl.deleteShader(fs);
		return undefined;
	}
	gl.attachShader(program, vs);
	gl.attachShader(program, fs);
	gl.linkProgram(program);
	gl.detachShader(program, vs);
	gl.detachShader(program, fs);
	gl.deleteShader(vs);
	gl.deleteShader(fs);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		gl.deleteProgram(program);
		return undefined;
	}

	const attribs = new Map<string, number>();
	for (const name of attribNames) {
		attribs.set(name, gl.getAttribLocation(program, name));
	}
	const uniforms = new Map<string, WebGLUniformLocation | null>();
	for (const name of uniformNames) {
		uniforms.set(name, gl.getUniformLocation(program, name));
	}
	return { program, attribs, uniforms };
}

/**
 * Interactive raw-WebGL 3D contour viewer for MAEngine FEA surface results.
 */
export class ResultViewer extends Disposable {

	static tryCreate(
		stageElement: HTMLElement,
		data: IResultViewData,
		onStateChange?: (state: IResultViewerState) => void
	): ResultViewer | undefined {
		const canvas = $<HTMLCanvasElement>('canvas.ma-results-canvas', {
			role: 'img',
			'aria-label': localize('results.canvasAria', "3D finite element contour model")
		});
		const attrs: WebGLContextAttributes = {
			antialias: true,
			alpha: false,
			depth: true,
			preserveDrawingBuffer: false,
		};
		const gl2 = canvas.getContext('webgl2', attrs);
		const gl: WebGLRenderingContext | null = gl2 ?? canvas.getContext('webgl', attrs);
		if (!gl) {
			return undefined;
		}

		const nodeCount = data.positions.length / 3;
		const useUint32 = nodeCount > 65535;
		if (useUint32 && !gl2 && !gl.getExtension('OES_element_index_uint')) {
			return undefined;
		}

		const surfaceProgram = createProgram(
			gl,
			SURFACE_VERT_SHADER,
			SURFACE_FRAG_SHADER,
			['aPosition', 'aNormal', 'aColor'],
			['uMvp', 'uView']
		);
		const edgeProgram = createProgram(
			gl,
			EDGE_VERT_SHADER,
			EDGE_FRAG_SHADER,
			['aPosition'],
			['uMvp', 'uEdgeColor']
		);
		if (!surfaceProgram || !edgeProgram) {
			if (surfaceProgram) { gl.deleteProgram(surfaceProgram.program); }
			if (edgeProgram) { gl.deleteProgram(edgeProgram.program); }
			return undefined;
		}

		const posBuf = gl.createBuffer();
		const normBuf = gl.createBuffer();
		const colBuf = gl.createBuffer();
		const idxBuf = gl.createBuffer();
		if (!posBuf || !normBuf || !colBuf || !idxBuf) {
			if (posBuf) { gl.deleteBuffer(posBuf); }
			if (normBuf) { gl.deleteBuffer(normBuf); }
			if (colBuf) { gl.deleteBuffer(colBuf); }
			if (idxBuf) { gl.deleteBuffer(idxBuf); }
			gl.deleteProgram(surfaceProgram.program);
			gl.deleteProgram(edgeProgram.program);
			return undefined;
		}

		append(stageElement, canvas);
		return new ResultViewer(
			stageElement,
			canvas,
			gl,
			useUint32,
			surfaceProgram,
			edgeProgram,
			posBuf,
			normBuf,
			colBuf,
			idxBuf,
			data,
			onStateChange
		);
	}

	private static readonly ANIMATION_PERIOD_MS = 1600;

	private readonly tooltip: HTMLElement;
	private readonly nodeCount: number;
	private readonly triCount: number;
	private readonly indexGlType: number;
	private readonly isModal: boolean;

	private readonly basePositions: Float32Array;
	private readonly baseDiag: number;
	private readonly deformedPositions: Float32Array;
	private readonly normals: Float32Array;
	private readonly colors: Float32Array;
	private displacement: Float32Array | null;
	private readonly indices: Uint16Array | Uint32Array;

	private readonly fields = new Map<string, IParsedField>();
	private readonly fieldOrder: IResultViewerFieldInfo[] = [];
	private activeFieldId: string;

	private autoScale: number;
	private scaleMode: DeformationScaleMode;
	private customScale = 1;
	private activeScale = 0;
	private edgesVisible = false;
	private animating = false;
	private animRaf = 0;
	private animStartTime: number | undefined;
	private animPhase = 1;
	private hostVisible = true;
	private isIntersecting = true;

	private readonly positionBuffer: WebGLBuffer;
	private readonly normalBuffer: WebGLBuffer;
	private readonly colorBuffer: WebGLBuffer;
	private readonly indexBuffer: WebGLBuffer;
	private edgeIndexBuffer: WebGLBuffer | undefined;
	private edgeVertexCount = 0;

	private readonly viewMatrix = new Float32Array(16);
	private readonly projMatrix = new Float32Array(16);
	private readonly mvpMatrix = new Float32Array(16);

	private targetX = 0;
	private targetY = 0;
	private targetZ = 0;
	private azimuth = Math.PI / 4;
	private elevation = Math.atan(1 / Math.SQRT2);
	private distance = 10;
	private readonly fovY = (38 * Math.PI) / 180;

	private deformedCenterX = 0;
	private deformedCenterY = 0;
	private deformedCenterZ = 0;
	private deformedRadius = 1;
	private lastNear = 0.01;
	private cssWidth = 0;
	private cssHeight = 0;
	private hasFittedWithValidSize = false;

	private bgColor: [number, number, number] = [1, 1, 1];
	private isDarkTheme = false;

	private dragMode: 'none' | 'orbit' | 'pan' = 'none';
	private dragPointerId = -1;
	private lastClientX = 0;
	private lastClientY = 0;

	private readonly bvh = new TriangleBVH();
	private bvhDirty = true;

	private renderRaf = 0;
	private probeRaf = 0;
	private pendingProbeClientX = 0;
	private pendingProbeClientY = 0;
	private isDisposed = false;

	private constructor(
		private readonly stageElement: HTMLElement,
		private readonly canvas: HTMLCanvasElement,
		private readonly gl: WebGLRenderingContext,
		private readonly useUint32: boolean,
		private readonly surfaceProgram: ICompiledProgram,
		private readonly edgeProgram: ICompiledProgram,
		positionBuffer: WebGLBuffer,
		normalBuffer: WebGLBuffer,
		colorBuffer: WebGLBuffer,
		indexBuffer: WebGLBuffer,
		data: IResultViewData,
		private readonly onStateChange?: (state: IResultViewerState) => void
	) {
		super();

		this.positionBuffer = positionBuffer;
		this.normalBuffer = normalBuffer;
		this.colorBuffer = colorBuffer;
		this.indexBuffer = indexBuffer;

		this.tooltip = append(this.stageElement, $('.ma-results-probe-tooltip'));
		this.tooltip.style.display = 'none';

		this.nodeCount = data.positions.length / 3;
		this.triCount = data.triangles.length / 3;
		this.indexGlType = useUint32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
		this.isModal = data.analysisType === 'modal_frequency';

		this.basePositions = new Float32Array(data.positions);
		this.deformedPositions = new Float32Array(data.positions.length);
		this.normals = new Float32Array(data.positions.length);
		this.colors = new Float32Array(data.positions.length);
		this.displacement = data.displacement ? new Float32Array(data.displacement) : null;

		if (useUint32) {
			const idx = new Uint32Array(data.triangles.length);
			for (let i = 0; i < data.triangles.length; i++) {
				idx[i] = data.triangles[i];
			}
			this.indices = idx;
		} else {
			const idx = new Uint16Array(data.triangles.length);
			for (let i = 0; i < data.triangles.length; i++) {
				idx[i] = data.triangles[i];
			}
			this.indices = idx;
		}

		// Compute undeformed bounding box diagonal and max nodal displacement for auto deformation scale.
		let minX = Infinity;
		let minY = Infinity;
		let minZ = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		let maxZ = -Infinity;
		for (let i = 0; i < this.nodeCount; i++) {
			const p = i * 3;
			const x = this.basePositions[p];
			const y = this.basePositions[p + 1];
			const z = this.basePositions[p + 2];
			if (x < minX) { minX = x; }
			if (y < minY) { minY = y; }
			if (z < minZ) { minZ = z; }
			if (x > maxX) { maxX = x; }
			if (y > maxY) { maxY = y; }
			if (z > maxZ) { maxZ = z; }
		}
		this.baseDiag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);

		this.autoScale = this.computeAutoScale();
		this.scaleMode = this.displacement ? 'auto' : 'undeformed';
		this.activeScale = this.scaleMode === 'auto' ? this.autoScale : 0;

		for (const [id, rawField] of Object.entries(data.fields)) {
			const values = new Float32Array(rawField.values);
			let fMin = Infinity;
			let fMax = -Infinity;
			for (let i = 0; i < values.length; i++) {
				const v = values[i];
				if (v < fMin) { fMin = v; }
				if (v > fMax) { fMax = v; }
			}
			if (!Number.isFinite(fMin)) { fMin = 0; }
			if (!Number.isFinite(fMax)) { fMax = 0; }
			this.fields.set(id, { id, label: rawField.label, unit: rawField.unit, values, min: fMin, max: fMax });
			this.fieldOrder.push({ id, label: rawField.label, unit: rawField.unit });
		}

		this.activeFieldId = this.fields.has('von_mises')
			? 'von_mises'
			: (this.fields.has('disp_mag') ? 'disp_mag' : this.fieldOrder[0].id);

		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
		gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.indices, gl.STATIC_DRAW);

		gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, this.deformedPositions.byteLength, gl.DYNAMIC_DRAW);

		gl.bindBuffer(gl.ARRAY_BUFFER, this.normalBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, this.normals.byteLength, gl.DYNAMIC_DRAW);

		gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, this.colors.byteLength, gl.DYNAMIC_DRAW);

		this.updateDeformedBounds();
		this.updateDeformedGeometry(false, this.activeScale);
		this.updateFieldColors(false);
		this.fitToModel();
		this.refreshTheme();
		this.bindEvents();
		this.layout();

		this._register(toDisposable(() => {
			this.canvas.remove();
			this.tooltip.remove();
		}));
	}

	getFields(): readonly IResultViewerFieldInfo[] {
		return this.fieldOrder;
	}

	getState(): IResultViewerState {
		const field = this.fields.get(this.activeFieldId)!;
		return {
			fieldId: field.id,
			fieldLabel: field.label,
			unit: field.unit,
			min: field.min,
			max: field.max,
			activeScale: this.activeScale,
			autoScale: this.autoScale,
			scaleMode: this.scaleMode,
			hasDisplacement: this.displacement !== null,
			edgesVisible: this.edgesVisible,
			animating: this.animating,
		};
	}

	setField(fieldId: string): void {
		if (!this.fields.has(fieldId) || this.activeFieldId === fieldId) {
			return;
		}
		this.activeFieldId = fieldId;
		this.updateFieldColors(true);
		this.hideProbeTooltip();
		this.emitState();
		this.requestRender();
	}

	setDisplacement(values: Float32Array | readonly number[]): void {
		if (this.isDisposed || values.length !== this.basePositions.length) {
			return;
		}
		if (this.displacement) {
			this.displacement.set(values);
		} else {
			this.displacement = new Float32Array(values);
		}

		const prevScale = this.activeScale;
		this.autoScale = this.computeAutoScale();
		if (this.scaleMode === 'auto') {
			this.activeScale = this.autoScale;
		} else if (this.scaleMode === 'undeformed') {
			this.activeScale = 0;
		} else if (this.scaleMode === 'true') {
			this.activeScale = 1;
		} else {
			this.activeScale = this.customScale;
		}

		this.updateDeformedBounds();
		if (prevScale !== 0 || this.activeScale !== 0) {
			this.updateDeformedGeometry(true, this.getCurrentDisplayScale());
		}
		this.hideProbeTooltip();
		this.emitState();
		this.syncAnimationLoop();
		if (this.animRaf === 0) {
			this.requestRender();
		}
	}

	setAnimate(on: boolean): void {
		if (this.isDisposed || this.animating === on) {
			return;
		}
		this.animating = on;
		if (on) {
			this.animStartTime = undefined;
			this.animPhase = 0;
			this.updateDeformedBounds();
			this.syncAnimationLoop();
		} else {
			this.stopAnimationLoop();
			this.animPhase = 1;
			this.updateDeformedBounds();
			this.updateDeformedGeometry(true, this.activeScale);
			this.hideProbeTooltip();
			this.requestRender();
		}
		this.emitState();
	}

	setVisible(visible: boolean): void {
		if (this.isDisposed || this.hostVisible === visible) {
			return;
		}
		this.hostVisible = visible;
		this.syncAnimationLoop();
	}

	setDeformationScale(mode: DeformationScaleMode, customScale?: number): void {
		let nextScale = 0;
		let nextMode = mode;
		if (!this.displacement) {
			nextMode = 'undeformed';
			nextScale = 0;
		} else if (mode === 'undeformed') {
			nextScale = 0;
		} else if (mode === 'true') {
			nextScale = 1;
		} else if (mode === 'auto') {
			nextScale = this.autoScale;
		} else {
			if (typeof customScale === 'number' && Number.isFinite(customScale)) {
				this.customScale = customScale;
			}
			nextScale = this.customScale;
		}

		this.scaleMode = nextMode;
		if (nextScale === this.activeScale) {
			this.emitState();
			return;
		}

		this.activeScale = nextScale;
		this.updateDeformedBounds();
		this.updateDeformedGeometry(true, this.getCurrentDisplayScale());
		this.hideProbeTooltip();
		this.emitState();
		this.syncAnimationLoop();
		if (this.animRaf === 0) {
			this.requestRender();
		}
	}

	setEdgesVisible(visible: boolean): void {
		if (this.edgesVisible === visible) {
			return;
		}
		this.edgesVisible = visible;
		if (visible && !this.edgeIndexBuffer) {
			this.buildEdgeBuffer();
		}
		this.emitState();
		this.requestRender();
	}

	fitToModel(): void {
		this.targetX = this.deformedCenterX;
		this.targetY = this.deformedCenterY;
		this.targetZ = this.deformedCenterZ;
		this.azimuth = Math.PI / 4;
		this.elevation = Math.atan(1 / Math.SQRT2);

		const aspect = this.cssHeight > 0 ? this.cssWidth / this.cssHeight : 1.4;
		const halfFovY = this.fovY * 0.5;
		const halfFovX = Math.atan(Math.tan(halfFovY) * Math.max(aspect, 1e-4));
		const limitingHalfFov = Math.min(halfFovX, halfFovY);
		const radius = Math.max(this.deformedRadius, 1e-3);
		this.distance = (radius / Math.max(Math.sin(limitingHalfFov), 0.05)) * 1.12;

		if (this.cssWidth > 0 && this.cssHeight > 0) {
			this.hasFittedWithValidSize = true;
		}
		this.hideProbeTooltip();
		this.requestRender();
	}

	layout(): void {
		if (this.isDisposed) {
			return;
		}
		const rect = this.stageElement.getBoundingClientRect();
		const width = Math.max(0, rect.width);
		const height = Math.max(0, rect.height);
		if (width <= 0 || height <= 0) {
			this.cssWidth = width;
			this.cssHeight = height;
			this.syncAnimationLoop();
			return;
		}

		const targetWindow = getWindow(this.stageElement);
		const dpr = Math.max(1, targetWindow.devicePixelRatio || 1);
		const pixelW = Math.max(1, Math.round(width * dpr));
		const pixelH = Math.max(1, Math.round(height * dpr));

		this.cssWidth = width;
		this.cssHeight = height;

		if (this.canvas.width !== pixelW || this.canvas.height !== pixelH) {
			this.canvas.width = pixelW;
			this.canvas.height = pixelH;
		}

		this.syncAnimationLoop();
		if (!this.hasFittedWithValidSize) {
			this.fitToModel();
			return;
		}
		if (this.animRaf === 0) {
			this.requestRender();
		}
	}

	refreshTheme(): void {
		if (this.isDisposed) {
			return;
		}
		const targetWindow = getWindow(this.stageElement);
		const style = targetWindow.getComputedStyle(this.stageElement);
		const editorBgVar = style.getPropertyValue('--vscode-editor-background');
		const parsed = parseCssColor(editorBgVar) ?? parseCssColor(style.backgroundColor) ?? [1, 1, 1];
		this.bgColor = parsed;
		const luminance = 0.2126 * parsed[0] + 0.7152 * parsed[1] + 0.0722 * parsed[2];
		this.isDarkTheme = luminance < 0.45;
		this.requestRender();
	}

	private emitState(): void {
		this.onStateChange?.(this.getState());
	}

	private computeAutoScale(): number {
		const disp = this.displacement;
		if (!disp || this.baseDiag <= 0) {
			return 0;
		}
		let maxDisp = 0;
		for (let i = 0; i < this.nodeCount; i++) {
			const p = i * 3;
			const d = Math.hypot(disp[p], disp[p + 1], disp[p + 2]);
			if (Number.isFinite(d) && d > maxDisp) {
				maxDisp = d;
			}
		}
		return maxDisp > 0 ? (0.05 * this.baseDiag) / maxDisp : 0;
	}

	private getCurrentDisplayScale(): number {
		return this.animating ? this.activeScale * this.animPhase : this.activeScale;
	}

	private shouldRunAnimation(): boolean {
		if (
			this.isDisposed ||
			!this.animating ||
			!this.displacement ||
			this.activeScale === 0 ||
			!this.hostVisible ||
			!this.isIntersecting ||
			this.cssWidth <= 0 ||
			this.cssHeight <= 0 ||
			!this.stageElement.isConnected ||
			this.gl.isContextLost()
		) {
			return false;
		}
		return !getWindow(this.stageElement).document.hidden;
	}

	private stopAnimationLoop(): void {
		if (this.animRaf !== 0) {
			getWindow(this.stageElement).cancelAnimationFrame(this.animRaf);
			this.animRaf = 0;
		}
		this.animStartTime = undefined;
	}

	private syncAnimationLoop(): void {
		if (this.shouldRunAnimation()) {
			if (this.animRaf === 0) {
				this.animStartTime = undefined;
				this.animRaf = getWindow(this.stageElement).requestAnimationFrame(this.onAnimationFrame);
			}
		} else {
			this.stopAnimationLoop();
		}
	}

	private readonly onAnimationFrame = (timestamp: number): void => {
		this.animRaf = 0;
		if (!this.shouldRunAnimation()) {
			return;
		}
		if (this.animStartTime === undefined) {
			this.animStartTime = timestamp;
		}
		const elapsedMs = Math.max(0, timestamp - this.animStartTime);
		this.animPhase = Math.sin((2 * Math.PI * elapsedMs) / ResultViewer.ANIMATION_PERIOD_MS);
		this.updateDeformedGeometry(true, this.activeScale * this.animPhase);

		if (this.renderRaf !== 0) {
			getWindow(this.stageElement).cancelAnimationFrame(this.renderRaf);
			this.renderRaf = 0;
		}
		this.renderFrame();

		if (this.shouldRunAnimation()) {
			this.animRaf = getWindow(this.stageElement).requestAnimationFrame(this.onAnimationFrame);
		}
	};

	private updateDeformedBounds(): void {
		const disp = this.displacement;
		const scale = this.activeScale;
		let minX = Infinity;
		let minY = Infinity;
		let minZ = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		let maxZ = -Infinity;

		if (!disp || scale === 0) {
			for (let i = 0; i < this.nodeCount; i++) {
				const p = i * 3;
				const x = this.basePositions[p];
				const y = this.basePositions[p + 1];
				const z = this.basePositions[p + 2];
				if (x < minX) { minX = x; }
				if (y < minY) { minY = y; }
				if (z < minZ) { minZ = z; }
				if (x > maxX) { maxX = x; }
				if (y > maxY) { maxY = y; }
				if (z > maxZ) { maxZ = z; }
			}
		} else if (!this.animating) {
			for (let i = 0; i < this.nodeCount; i++) {
				const p = i * 3;
				const x = this.basePositions[p] + scale * disp[p];
				const y = this.basePositions[p + 1] + scale * disp[p + 1];
				const z = this.basePositions[p + 2] + scale * disp[p + 2];
				if (x < minX) { minX = x; }
				if (y < minY) { minY = y; }
				if (z < minZ) { minZ = z; }
				if (x > maxX) { maxX = x; }
				if (y > maxY) { maxY = y; }
				if (z > maxZ) { maxZ = z; }
			}
		} else {
			for (let i = 0; i < this.nodeCount; i++) {
				const p = i * 3;
				const bx = this.basePositions[p];
				const by = this.basePositions[p + 1];
				const bz = this.basePositions[p + 2];
				const dx = scale * disp[p];
				const dy = scale * disp[p + 1];
				const dz = scale * disp[p + 2];
				const xPlus = bx + dx;
				const xMinus = bx - dx;
				const yPlus = by + dy;
				const yMinus = by - dy;
				const zPlus = bz + dz;
				const zMinus = bz - dz;
				if (xPlus < minX) { minX = xPlus; }
				if (xMinus < minX) { minX = xMinus; }
				if (yPlus < minY) { minY = yPlus; }
				if (yMinus < minY) { minY = yMinus; }
				if (zPlus < minZ) { minZ = zPlus; }
				if (zMinus < minZ) { minZ = zMinus; }
				if (xPlus > maxX) { maxX = xPlus; }
				if (xMinus > maxX) { maxX = xMinus; }
				if (yPlus > maxY) { maxY = yPlus; }
				if (yMinus > maxY) { maxY = yMinus; }
				if (zPlus > maxZ) { maxZ = zPlus; }
				if (zMinus > maxZ) { maxZ = zMinus; }
			}
		}

		this.deformedCenterX = 0.5 * (minX + maxX);
		this.deformedCenterY = 0.5 * (minY + maxY);
		this.deformedCenterZ = 0.5 * (minZ + maxZ);
		this.deformedRadius = Math.max(0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ), 1e-3);
	}

	private updateDeformedGeometry(upload: boolean, scale: number = this.activeScale): void {
		const disp = this.displacement;
		if (disp && scale !== 0) {
			for (let i = 0; i < this.basePositions.length; i++) {
				this.deformedPositions[i] = this.basePositions[i] + scale * disp[i];
			}
		} else {
			this.deformedPositions.set(this.basePositions);
		}

		this.recomputeNormals();
		this.bvhDirty = true;

		if (upload) {
			const gl = this.gl;
			gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
			gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.deformedPositions);
			gl.bindBuffer(gl.ARRAY_BUFFER, this.normalBuffer);
			gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.normals);
		} else {
			const gl = this.gl;
			gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
			gl.bufferData(gl.ARRAY_BUFFER, this.deformedPositions, gl.DYNAMIC_DRAW);
			gl.bindBuffer(gl.ARRAY_BUFFER, this.normalBuffer);
			gl.bufferData(gl.ARRAY_BUFFER, this.normals, gl.DYNAMIC_DRAW);
		}
	}

	private recomputeNormals(): void {
		this.normals.fill(0);
		for (let t = 0; t < this.triCount; t++) {
			const base = t * 3;
			const i0 = this.indices[base] * 3;
			const i1 = this.indices[base + 1] * 3;
			const i2 = this.indices[base + 2] * 3;

			const ax = this.deformedPositions[i0];
			const ay = this.deformedPositions[i0 + 1];
			const az = this.deformedPositions[i0 + 2];

			const e1x = this.deformedPositions[i1] - ax;
			const e1y = this.deformedPositions[i1 + 1] - ay;
			const e1z = this.deformedPositions[i1 + 2] - az;

			const e2x = this.deformedPositions[i2] - ax;
			const e2y = this.deformedPositions[i2 + 1] - ay;
			const e2z = this.deformedPositions[i2 + 2] - az;

			const nx = e1y * e2z - e1z * e2y;
			const ny = e1z * e2x - e1x * e2z;
			const nz = e1x * e2y - e1y * e2x;

			this.normals[i0] += nx;
			this.normals[i0 + 1] += ny;
			this.normals[i0 + 2] += nz;

			this.normals[i1] += nx;
			this.normals[i1 + 1] += ny;
			this.normals[i1 + 2] += nz;

			this.normals[i2] += nx;
			this.normals[i2 + 1] += ny;
			this.normals[i2 + 2] += nz;
		}

		for (let i = 0; i < this.nodeCount; i++) {
			const p = i * 3;
			const nx = this.normals[p];
			const ny = this.normals[p + 1];
			const nz = this.normals[p + 2];
			const len = Math.hypot(nx, ny, nz);
			if (len > 1e-20) {
				this.normals[p] = nx / len;
				this.normals[p + 1] = ny / len;
				this.normals[p + 2] = nz / len;
			} else {
				this.normals[p] = 0;
				this.normals[p + 1] = 0;
				this.normals[p + 2] = 1;
			}
		}
	}

	private updateFieldColors(upload: boolean): void {
		const field = this.fields.get(this.activeFieldId)!;
		const values = field.values;
		const range = field.max - field.min;
		if (range <= 0) {
			const c = COLORMAP_STOPS[0];
			for (let i = 0; i < this.nodeCount; i++) {
				const p = i * 3;
				this.colors[p] = c[0];
				this.colors[p + 1] = c[1];
				this.colors[p + 2] = c[2];
			}
		} else {
			const invRange = 1 / range;
			for (let i = 0; i < this.nodeCount; i++) {
				const t = (values[i] - field.min) * invRange;
				sampleColormap(t, this.colors, i * 3);
			}
		}

		const gl = this.gl;
		gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
		if (upload) {
			gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.colors);
		} else {
			gl.bufferData(gl.ARRAY_BUFFER, this.colors, gl.DYNAMIC_DRAW);
		}
	}

	private buildEdgeBuffer(): void {
		const edgeSet = new Set<number>();
		const stride = this.nodeCount;
		const addEdge = (a: number, b: number) => {
			if (a === b) {
				return;
			}
			const lo = a < b ? a : b;
			const hi = a < b ? b : a;
			edgeSet.add(lo * stride + hi);
		};

		for (let t = 0; t < this.triCount; t++) {
			const base = t * 3;
			const i0 = this.indices[base];
			const i1 = this.indices[base + 1];
			const i2 = this.indices[base + 2];
			addEdge(i0, i1);
			addEdge(i1, i2);
			addEdge(i2, i0);
		}

		const edgeArray = this.useUint32
			? new Uint32Array(edgeSet.size * 2)
			: new Uint16Array(edgeSet.size * 2);
		let k = 0;
		for (const key of edgeSet) {
			const lo = Math.floor(key / stride);
			const hi = key - lo * stride;
			edgeArray[k++] = lo;
			edgeArray[k++] = hi;
		}
		this.edgeVertexCount = k;

		const buf = this.gl.createBuffer();
		if (!buf) {
			return;
		}
		this.edgeIndexBuffer = buf;
		this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, buf);
		this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, edgeArray, this.gl.STATIC_DRAW);
	}

	private bindEvents(): void {
		this._register(addDisposableListener(this.canvas, EventType.POINTER_DOWN, (e: PointerEvent) => {
			if (e.button !== 0 && e.button !== 1 && e.button !== 2) {
				return;
			}
			e.preventDefault();
			this.cancelHoverProbe();
			this.hideProbeTooltip();
			this.dragMode = (e.button === 2 || e.button === 1 || e.shiftKey) ? 'pan' : 'orbit';
			this.dragPointerId = e.pointerId;
			this.lastClientX = e.clientX;
			this.lastClientY = e.clientY;
			this.canvas.classList.add('dragging');
			try {
				this.canvas.setPointerCapture(e.pointerId);
			} catch {
				// Ignore if pointer capture is unsupported for synthetic events
			}
		}));

		this._register(addDisposableListener(this.canvas, EventType.POINTER_MOVE, (e: PointerEvent) => {
			if (this.dragMode !== 'none' && e.pointerId === this.dragPointerId) {
				const dx = e.clientX - this.lastClientX;
				const dy = e.clientY - this.lastClientY;
				this.lastClientX = e.clientX;
				this.lastClientY = e.clientY;

				if (this.dragMode === 'orbit') {
					this.azimuth -= dx * 0.007;
					const maxEl = Math.PI * 0.495;
					this.elevation = Math.max(-maxEl, Math.min(maxEl, this.elevation + dy * 0.007));
				} else {
					this.panByPixels(dx, dy);
				}
				this.requestRender();
				return;
			}

			if (this.dragMode === 'none') {
				this.scheduleHoverProbe(e.clientX, e.clientY);
			}
		}));

		const endDrag = (e: PointerEvent) => {
			if (e.pointerId !== this.dragPointerId) {
				return;
			}
			this.dragMode = 'none';
			this.dragPointerId = -1;
			this.canvas.classList.remove('dragging');
			try {
				if (this.canvas.hasPointerCapture(e.pointerId)) {
					this.canvas.releasePointerCapture(e.pointerId);
				}
			} catch {
				// Ignore capture release errors
			}
		};

		this._register(addDisposableListener(this.canvas, EventType.POINTER_UP, endDrag));
		this._register(addDisposableListener(this.canvas, 'pointercancel', endDrag));
		this._register(addDisposableListener(this.canvas, EventType.POINTER_LEAVE, () => {
			this.cancelHoverProbe();
			this.hideProbeTooltip();
		}));

		this._register(addDisposableListener(this.canvas, EventType.CONTEXT_MENU, e => {
			e.preventDefault();
		}));

		this._register(addDisposableListener(this.canvas, EventType.DBLCLICK, () => {
			this.fitToModel();
		}));

		this._register(addDisposableListener(this.canvas, EventType.WHEEL, (e: WheelEvent) => {
			e.preventDefault();
			this.cancelHoverProbe();
			this.hideProbeTooltip();
			const factor = Math.exp(Math.max(-240, Math.min(240, e.deltaY)) * 0.0012);
			const minDist = Math.max(this.deformedRadius * 0.02, 1e-4);
			const maxDist = Math.max(this.deformedRadius * 50, 100);
			this.distance = Math.max(minDist, Math.min(maxDist, this.distance * factor));
			this.requestRender();
		}, { passive: false }));

		this._register(addDisposableListener(this.canvas, 'webglcontextlost', e => {
			e.preventDefault();
			this.cancelPendingFrames();
		}));

		const targetWindow = getWindow(this.stageElement);
		this._register(addDisposableListener(targetWindow.document, 'visibilitychange', () => {
			this.syncAnimationLoop();
		}));

		const ObserverCtor = targetWindow.IntersectionObserver;
		if (typeof ObserverCtor === 'function') {
			const observer = new ObserverCtor(entries => {
				const last = entries[entries.length - 1];
				if (last) {
					this.isIntersecting = last.isIntersecting;
					this.syncAnimationLoop();
				}
			});
			observer.observe(this.stageElement);
			this._register(toDisposable(() => observer.disconnect()));
		}
	}

	private getCameraBasis(): {
		readonly ex: number; readonly ey: number; readonly ez: number;
		readonly fx: number; readonly fy: number; readonly fz: number;
		readonly rx: number; readonly ry: number; readonly rz: number;
		readonly ux: number; readonly uy: number; readonly uz: number;
	} {
		const cosEl = Math.cos(this.elevation);
		const sinEl = Math.sin(this.elevation);
		const dx = cosEl * Math.cos(this.azimuth);
		const dy = cosEl * Math.sin(this.azimuth);
		const dz = sinEl;

		const ex = this.targetX + this.distance * dx;
		const ey = this.targetY + this.distance * dy;
		const ez = this.targetZ + this.distance * dz;

		const fx = -dx;
		const fy = -dy;
		const fz = -dz;

		// right = normalize(cross(forward, worldUp(0, 0, 1)))
		let rx = fy;
		let ry = -fx;
		const rLen = Math.hypot(rx, ry);
		if (rLen > 1e-12) {
			rx /= rLen;
			ry /= rLen;
		} else {
			rx = 1;
			ry = 0;
		}
		const rz = 0;

		// camUp = cross(right, forward)
		const ux = ry * fz - rz * fy;
		const uy = rz * fx - rx * fz;
		const uz = rx * fy - ry * fx;

		return { ex, ey, ez, fx, fy, fz, rx, ry, rz, ux, uy, uz };
	}

	private panByPixels(deltaX: number, deltaY: number): void {
		if (this.cssHeight <= 0) {
			return;
		}
		const basis = this.getCameraBasis();
		const worldPerPx = (2 * this.distance * Math.tan(this.fovY * 0.5)) / this.cssHeight;
		const moveRight = -deltaX * worldPerPx;
		const moveUp = deltaY * worldPerPx;
		this.targetX += basis.rx * moveRight + basis.ux * moveUp;
		this.targetY += basis.ry * moveRight + basis.uy * moveUp;
		this.targetZ += basis.rz * moveRight + basis.uz * moveUp;
	}

	private scheduleHoverProbe(clientX: number, clientY: number): void {
		this.pendingProbeClientX = clientX;
		this.pendingProbeClientY = clientY;
		if (this.probeRaf !== 0 || this.isDisposed) {
			return;
		}
		const targetWindow = getWindow(this.stageElement);
		this.probeRaf = targetWindow.requestAnimationFrame(() => {
			this.probeRaf = 0;
			if (!this.isDisposed && this.dragMode === 'none') {
				this.runHoverProbe(this.pendingProbeClientX, this.pendingProbeClientY);
			}
		});
	}

	private cancelHoverProbe(): void {
		if (this.probeRaf !== 0) {
			getWindow(this.stageElement).cancelAnimationFrame(this.probeRaf);
			this.probeRaf = 0;
		}
	}

	private runHoverProbe(clientX: number, clientY: number): void {
		const rect = this.canvas.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) {
			this.hideProbeTooltip();
			return;
		}
		const localX = clientX - rect.left;
		const localY = clientY - rect.top;
		if (localX < 0 || localY < 0 || localX > rect.width || localY > rect.height) {
			this.hideProbeTooltip();
			return;
		}

		if (this.bvhDirty) {
			this.bvh.build(this.deformedPositions, this.indices, this.triCount);
			this.bvhDirty = false;
		}

		const ndcX = (localX / rect.width) * 2 - 1;
		const ndcY = 1 - (localY / rect.height) * 2;
		const aspect = rect.width / rect.height;
		const tanHalfY = Math.tan(this.fovY * 0.5);
		const tanHalfX = tanHalfY * aspect;

		const basis = this.getCameraBasis();
		const dirX = basis.fx + basis.rx * (ndcX * tanHalfX) + basis.ux * (ndcY * tanHalfY);
		const dirY = basis.fy + basis.ry * (ndcX * tanHalfX) + basis.uy * (ndcY * tanHalfY);
		const dirZ = basis.fz + basis.rz * (ndcX * tanHalfX) + basis.uz * (ndcY * tanHalfY);
		const dirLen = Math.hypot(dirX, dirY, dirZ);
		if (dirLen < 1e-12) {
			this.hideProbeTooltip();
			return;
		}

		const hit = this.bvh.pick(
			this.deformedPositions,
			this.indices,
			basis.ex, basis.ey, basis.ez,
			dirX / dirLen, dirY / dirLen, dirZ / dirLen,
			this.lastNear * 0.5
		);
		if (!hit) {
			this.hideProbeTooltip();
			return;
		}

		const field = this.fields.get(this.activeFieldId)!;
		const base = hit.triIndex * 3;
		const i0 = this.indices[base];
		const i1 = this.indices[base + 1];
		const i2 = this.indices[base + 2];
		const w = 1 - hit.u - hit.v;
		let value = w * field.values[i0] + hit.u * field.values[i1] + hit.v * field.values[i2];
		if (Math.abs(value) < (field.max - field.min) * 1e-12) {
			value = 0;
		}

		const formatted = formatResultNumber(value);
		let label = field.label;
		let valueText = field.unit ? `${formatted} ${field.unit}` : formatted;
		if (this.isModal) {
			const match = /^mode_(\d+)$/.exec(field.id);
			if (match) {
				label = localize('results.modalFieldLabel', "Mode {0} shape (relative)", match[1]);
			}
			valueText = formatted;
		}
		this.tooltip.textContent = `${label}: ${valueText}`;
		this.tooltip.style.display = 'block';

		const tipW = this.tooltip.offsetWidth;
		const tipH = this.tooltip.offsetHeight;
		const x = Math.min(localX + 14, Math.max(4, rect.width - tipW - 6));
		const y = Math.min(localY + 14, Math.max(4, rect.height - tipH - 6));
		this.tooltip.style.left = `${Math.round(x)}px`;
		this.tooltip.style.top = `${Math.round(y)}px`;
	}

	private hideProbeTooltip(): void {
		if (this.tooltip.style.display !== 'none') {
			this.tooltip.style.display = 'none';
		}
	}

	private requestRender(): void {
		if (this.renderRaf !== 0 || this.animRaf !== 0 || this.isDisposed) {
			return;
		}
		const targetWindow = getWindow(this.stageElement);
		this.renderRaf = targetWindow.requestAnimationFrame(() => {
			this.renderRaf = 0;
			if (!this.isDisposed) {
				this.renderFrame();
			}
		});
	}

	private renderFrame(): void {
		const gl = this.gl;
		if (this.canvas.width <= 0 || this.canvas.height <= 0 || gl.isContextLost()) {
			return;
		}

		gl.viewport(0, 0, this.canvas.width, this.canvas.height);
		gl.clearColor(this.bgColor[0], this.bgColor[1], this.bgColor[2], 1);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
		gl.enable(gl.DEPTH_TEST);
		gl.disable(gl.CULL_FACE);

		const aspect = this.canvas.width / this.canvas.height;
		const span = Math.max(this.deformedRadius, 1e-3);
		const far = Math.max(this.distance + span * 4, span * 10);
		const near = Math.max(this.distance - span * 3, far * 1e-4);
		this.lastNear = near;

		const basis = this.getCameraBasis();
		makeLookAt(
			basis.ex, basis.ey, basis.ez,
			this.targetX, this.targetY, this.targetZ,
			0, 0, 1,
			this.viewMatrix
		);
		makePerspective(this.fovY, aspect, near, far, this.projMatrix);
		multiplyMat4(this.projMatrix, this.viewMatrix, this.mvpMatrix);

		// Draw contoured surface mesh
		gl.useProgram(this.surfaceProgram.program);
		const uMvp = this.surfaceProgram.uniforms.get('uMvp');
		const uView = this.surfaceProgram.uniforms.get('uView');
		if (uMvp) { gl.uniformMatrix4fv(uMvp, false, this.mvpMatrix); }
		if (uView) { gl.uniformMatrix4fv(uView, false, this.viewMatrix); }

		const aPos = this.surfaceProgram.attribs.get('aPosition') ?? -1;
		const aNorm = this.surfaceProgram.attribs.get('aNormal') ?? -1;
		const aCol = this.surfaceProgram.attribs.get('aColor') ?? -1;

		if (aPos >= 0) {
			gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
			gl.enableVertexAttribArray(aPos);
			gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
		}
		if (aNorm >= 0) {
			gl.bindBuffer(gl.ARRAY_BUFFER, this.normalBuffer);
			gl.enableVertexAttribArray(aNorm);
			gl.vertexAttribPointer(aNorm, 3, gl.FLOAT, false, 0, 0);
		}
		if (aCol >= 0) {
			gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
			gl.enableVertexAttribArray(aCol);
			gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, 0, 0);
		}

		if (this.edgesVisible) {
			gl.enable(gl.POLYGON_OFFSET_FILL);
			gl.polygonOffset(1.0, 1.0);
		}

		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
		gl.drawElements(gl.TRIANGLES, this.triCount * 3, this.indexGlType, 0);

		if (this.edgesVisible) {
			gl.disable(gl.POLYGON_OFFSET_FILL);
		}

		if (aPos >= 0) { gl.disableVertexAttribArray(aPos); }
		if (aNorm >= 0) { gl.disableVertexAttribArray(aNorm); }
		if (aCol >= 0) { gl.disableVertexAttribArray(aCol); }

		// Draw faint triangle edges when toggled on
		if (this.edgesVisible && this.edgeIndexBuffer && this.edgeVertexCount > 0) {
			gl.useProgram(this.edgeProgram.program);
			const edgeMvp = this.edgeProgram.uniforms.get('uMvp');
			const edgeColor = this.edgeProgram.uniforms.get('uEdgeColor');
			if (edgeMvp) { gl.uniformMatrix4fv(edgeMvp, false, this.mvpMatrix); }
			if (edgeColor) {
				if (this.isDarkTheme) {
					gl.uniform4f(edgeColor, 0.92, 0.94, 0.98, 0.30);
				} else {
					gl.uniform4f(edgeColor, 0.10, 0.12, 0.16, 0.32);
				}
			}

			const edgePos = this.edgeProgram.attribs.get('aPosition') ?? -1;
			if (edgePos >= 0) {
				gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
				gl.enableVertexAttribArray(edgePos);
				gl.vertexAttribPointer(edgePos, 3, gl.FLOAT, false, 0, 0);
			}

			gl.enable(gl.BLEND);
			gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
			gl.depthMask(false);

			gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.edgeIndexBuffer);
			gl.drawElements(gl.LINES, this.edgeVertexCount, this.indexGlType, 0);

			gl.depthMask(true);
			gl.disable(gl.BLEND);

			if (edgePos >= 0) { gl.disableVertexAttribArray(edgePos); }
		}
	}

	private cancelPendingFrames(): void {
		const targetWindow = getWindow(this.stageElement);
		if (this.renderRaf !== 0) {
			targetWindow.cancelAnimationFrame(this.renderRaf);
			this.renderRaf = 0;
		}
		if (this.probeRaf !== 0) {
			targetWindow.cancelAnimationFrame(this.probeRaf);
			this.probeRaf = 0;
		}
		this.stopAnimationLoop();
	}

	override dispose(): void {
		if (this.isDisposed) {
			super.dispose();
			return;
		}
		this.isDisposed = true;
		this.cancelPendingFrames();

		const gl = this.gl;
		if (!gl.isContextLost()) {
			gl.deleteBuffer(this.positionBuffer);
			gl.deleteBuffer(this.normalBuffer);
			gl.deleteBuffer(this.colorBuffer);
			gl.deleteBuffer(this.indexBuffer);
			if (this.edgeIndexBuffer) {
				gl.deleteBuffer(this.edgeIndexBuffer);
			}
			gl.deleteProgram(this.surfaceProgram.program);
			gl.deleteProgram(this.edgeProgram.program);
			gl.getExtension('WEBGL_lose_context')?.loseContext();
		}
		this.edgeIndexBuffer = undefined;

		super.dispose();
	}
}
