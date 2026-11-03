// ---------------------------------------------------------------------------
// lib/version.js — hot-reload version + dynamic-import bootstrap.
//
// The VERSION constant below IS the version file. The `bump_cbg_version`
// effect rewrites this file in place with an incremented number. There is
// no separate cbg.version file anywhere.
//
// Every reloadable file in lib/ does ONE static import from here
// (`import { versionedImport } from "./version.js"`) and gets the rest of
// its dependencies through versionedImport. That's what makes hot reload
// work: each version bump gives every versionedImport a new query string,
// which Deno treats as a new module URL, cascading freshness through the
// whole graph.
//
// DO NOT edit VERSION by hand — use `cbg reinstall` (it refreshes on-disk
// install artifacts AND hot-reloads the running daemon, which bumps this
// file via the `bump_cbg_version` effect).
// ---------------------------------------------------------------------------

export const VERSION = 265

if (typeof globalThis.cbgVersion !== "number") {
    globalThis.cbgVersion = VERSION
}

/**
 * Dynamically import a module with the current cbgVersion as a cache-buster.
 *
 * @param {string} specifier — relative or absolute import specifier,
 *   resolved against `importMeta.url` (so `"./foo.js"` works the same
 *   as a static import would in the calling file).
 * @param {ImportMeta} importMeta — always pass `import.meta` from the
 *   calling file so relative paths resolve correctly.
 * @returns {Promise<object>} — the imported module namespace object.
 */
export async function versionedImport(specifier, importMeta) {
    if (!importMeta || typeof importMeta.url !== "string") {
        throw new Error(
            `versionedImport: importMeta.url is required. Did you forget to pass import.meta?`
        )
    }
    const base = importMeta.url
    const resolved = new URL(specifier, base).href
    const salted = `${resolved}?v=${globalThis.cbgVersion ?? 1}`
    // One import() per URL, shared by every caller. Deno >=2.7 panics
    // ("RefCell already borrowed", libs/core/modules/map.rs) when a
    // second dynamic import() of a URL lands while that module is still
    // mid top-level-await — which our graph does constantly (two
    // modules TLA-importing logging.js?v=N at once). Handing the second
    // caller the first caller's promise never re-enters the loader.
    // Repro: tests/versioned-import-test.js.
    const pending = globalThis.cbgImportPromises ??= new Map()
    if (!pending.has(salted)) {
        const promise = import(salted)
        // Drop failures so a later call (e.g. after the file is fixed)
        // retries instead of replaying. The error itself still reaches
        // every caller through the awaited promise below.
        promise.catch(() => pending.delete(salted))
        pending.set(salted, promise)
    }
    return await pending.get(salted)
}
