/**
 * `scripts/dev-port.mjs` 的类型声明（手写，避免 TS7016；形状恒定）。
 */
export declare function portInUse(port: number, host?: string): Promise<boolean>
