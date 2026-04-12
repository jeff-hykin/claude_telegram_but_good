import { versionedImport } from "../../../lib/version.js"

const [
    { stringifyYaml, colors },
    { readConfig, getConfig, setConfig },
] = await Promise.all([
    versionedImport("../../../imports.js", import.meta),
    versionedImport("../../../lib/config.js", import.meta),
])
const c = colors

export function runConfig(args) {
    if (args.length === 0) {
        const config = readConfig()
        if (Object.keys(config).length === 0) {
            console.log(c.dim("  # No config set yet. Use: ") + c.white("cbg config <key> <value>"))
        } else {
            console.log(stringifyYaml(config).trimEnd())
        }
    } else if (args.length === 1) {
        const val = getConfig(args[0])
        if (val === undefined) {
            console.log(c.dim("(not set)"))
        } else {
            console.log(typeof val === "object" ? JSON.stringify(val) : String(val))
        }
    } else {
        setConfig(args[0], args.slice(1).join(" "))
        console.log(c.green("  \u2714 Set ") + c.white(args[0]))
    }
}
