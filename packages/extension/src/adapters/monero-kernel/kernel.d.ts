/* tslint:disable */
/* eslint-disable */

export function commitment(mask: string, amount: string): string;

export function hash_point(public_key: string): string;

export function prove(amounts: string, masks: string, seed: Uint8Array): string;

export function software_images(spend: Uint8Array, view: Uint8Array, inputs: string): string;

export function software_output(secret: Uint8Array, view: string, spend: string, index: number, amount: string): Uint8Array;

export function software_sign(spend: Uint8Array, view: Uint8Array, inputs: string, sum_outputs: string, message: string, seed: Uint8Array): string;

/**
 * Independently parse the native transaction, check proof, CLSAGs, and commitment balance.
 */
export function verify_transaction(bytes: Uint8Array, sources: string, seed: Uint8Array): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly commitment: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly hash_point: (a: number, b: number) => [number, number, number, number];
    readonly prove: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly software_images: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly software_output: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number, number];
    readonly software_sign: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number, number, number];
    readonly verify_transaction: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;


export function wipe(): void;
