/**
 * dsh-codex-atlas — Atlas: Spec-Driven Development for DeepSeek Harness.
 *
 * Maintains one shared source of truth per workspace:
 * - `MEMORY.md` — the project map injected into the system prompt;
 * - `SPEC.md` in every module folder — the static local specification;
 * - `JOURNAL.md` — an append-only event log that is never injected into the
 *   prompt and is written only at the end of a session.
 *
 * Four model tools keep the files current (`update_memory`, `update_spec`,
 * `log_session`, `sync_atlas`). The plugin reads and writes local files only:
 * no network calls, no child processes.
 * @module dsh-codex-atlas
 */
import type { Context } from '@deepseek-ai/cordis';
/** Stable Cordis plugin name. */
export declare const name = "dsh-codex-atlas";
/** Registries the tools and the prompt section mount into. */
export declare const inject: string[];
export declare function apply(ctx: Context): void;
