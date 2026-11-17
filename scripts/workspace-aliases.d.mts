/**
 * `scripts/workspace-aliases.mjs` 的类型声明（该文件由 `pnpm gen:paths` 生成，内容随包清单变，
 * 但形状恒为「正则 → 绝对路径」）。手写、不参与生成，避免 TS 报 TS7016。
 */
export declare const workspaceAliases: ReadonlyArray<{ find: RegExp; replacement: string }>
