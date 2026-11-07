// The shape of hook.js's import graph (paths, logging, pid) reduced to
// its trigger: l.js is loaded both statically and as l.js?v=N, and both
// copies TLA-import s.js?v=N at once. A raw import() per call panics
// Deno >=2.7 here; versionedImport must not.
import "./p.js"
import "./l.js"
import "./d.js"
console.log("ok")
