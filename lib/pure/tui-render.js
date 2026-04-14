// tui-render.js — Tiny VT100/ANSI terminal emulator.
//
// Takes a stream of bytes (as a string) that a TUI program would have
// written to a real terminal — complete with ANSI escape sequences for
// cursor movement, erase, colors, etc. — and replays it onto a virtual
// screen of a fixed width × height. Returns the final rendered screen
// as a string.
//
// Handles the ECMA-48 subset that matters for real-world TUI output:
//   CUP/HVP  CSI n;m H|f     absolute cursor position
//   CUU/D/F/B CSI n A|B|C|D  relative cursor move
//   CHA      CSI n G         cursor to column
//   VPA      CSI n d         cursor to row
//   ED       CSI n J         erase display (0=below, 1=above, 2=all)
//   EL       CSI n K         erase line    (0=right, 1=left,  2=all)
//   SGR      CSI ... m       colors/styles (tracked per cell if ansi=true)
//   DECSC/RC ESC 7 / ESC 8   save/restore cursor
//   SCP/RCP  CSI s / CSI u   save/restore cursor
//   \r \n \b \t              control chars, with auto-wrap + scroll
//   CSI ? ... h|l            private modes — parsed and ignored
//
// Usage:
//   import { renderTui } from "./lib/tui-render.js"
//   const screen = renderTui(rawBytes, { width: 80, height: 24 })
//   const colored = renderTui(rawBytes, { width: 80, height: 24, ansi: true })

const BLANK = " "

function makeGrid(w, h) {
    const g = new Array(h)
    for (let y = 0; y < h; y++) {
        g[y] = new Array(w)
        for (let x = 0; x < w; x++) {
            g[y][x] = { ch: BLANK, sgr: "" }
        }
    }
    return g
}

export function renderTui(input, opts = {}) {
    const width = opts.width ?? 80
    const height = opts.height ?? 24
    const ansi = opts.ansi ?? false
    const trim = opts.trim ?? true

    let grid = makeGrid(width, height)
    let cx = 0
    let cy = 0
    let sgr = "" // current SGR string, e.g. "\x1b[1;31m"
    let savedCx = 0
    let savedCy = 0

    const clamp = () => {
        if (cx < 0) { cx = 0 }
        if (cx >= width) { cx = width - 1 }
        if (cy < 0) { cy = 0 }
        if (cy >= height) { cy = height - 1 }
    }

    const scrollUp = () => {
        grid.shift()
        const row = new Array(width)
        for (let x = 0; x < width; x++) {
            row[x] = { ch: BLANK, sgr: "" }
        }
        grid.push(row)
    }

    const putChar = (ch) => {
        if (cx >= width) {
            cx = 0
            cy++
            if (cy >= height) {
                scrollUp()
                cy = height - 1
            }
        }
        grid[cy][cx] = { ch, sgr }
        cx++
    }

    const eraseRange = (y, x0, x1) => {
        for (let x = x0; x < x1; x++) {
            grid[y][x] = { ch: BLANK, sgr: "" }
        }
    }

    let i = 0
    const n = input.length

    while (i < n) {
        const c = input[i]
        const code = input.charCodeAt(i)

        // ESC sequences
        if (code === 0x1b) {
            const next = input[i + 1]
            if (next === "[") {
                // CSI — parse parameter bytes, optional intermediate, final byte
                let j = i + 2
                let priv = ""
                if (j < n && (input[j] === "?" || input[j] === ">" || input[j] === "=")) {
                    priv = input[j]
                    j++
                }
                let params = ""
                while (j < n) {
                    const cc = input.charCodeAt(j)
                    if (cc >= 0x30 && cc <= 0x3f) { // 0-9 ; : < = > ?
                        params += input[j]
                        j++
                    } else {
                        break
                    }
                }
                // intermediate bytes (rare)
                while (j < n) {
                    const cc = input.charCodeAt(j)
                    if (cc >= 0x20 && cc <= 0x2f) {
                        j++
                    } else {
                        break
                    }
                }
                if (j >= n) { break }
                const final = input[j]
                const args = params.split(";").map((s) => s === "" ? NaN : parseInt(s, 10))
                const arg = (k, dflt) => {
                    const v = args[k]
                    return Number.isFinite(v) ? v : dflt
                }

                i = j + 1

                if (priv === "?") {
                    // private modes (DECSET/DECRST) — ignore: cursor visibility,
                    // alt screen, bracketed paste, mouse, etc.
                    continue
                }

                switch (final) {
                    case "A": cy -= arg(0, 1); clamp(); break
                    case "B": cy += arg(0, 1); clamp(); break
                    case "C": cx += arg(0, 1); clamp(); break
                    case "D": cx -= arg(0, 1); clamp(); break
                    case "E": cy += arg(0, 1); cx = 0; clamp(); break
                    case "F": cy -= arg(0, 1); cx = 0; clamp(); break
                    case "G": cx = arg(0, 1) - 1; clamp(); break
                    case "d": cy = arg(0, 1) - 1; clamp(); break
                    case "H":
                    case "f": {
                        cy = arg(0, 1) - 1
                        cx = arg(1, 1) - 1
                        clamp()
                        break
                    }
                    case "J": {
                        const mode = arg(0, 0)
                        if (mode === 0) {
                            eraseRange(cy, cx, width)
                            for (let y = cy + 1; y < height; y++) { eraseRange(y, 0, width) }
                        } else if (mode === 1) {
                            eraseRange(cy, 0, cx + 1)
                            for (let y = 0; y < cy; y++) { eraseRange(y, 0, width) }
                        } else if (mode === 2 || mode === 3) {
                            for (let y = 0; y < height; y++) { eraseRange(y, 0, width) }
                        }
                        break
                    }
                    case "K": {
                        const mode = arg(0, 0)
                        if (mode === 0) { eraseRange(cy, cx, width) }
                        else if (mode === 1) { eraseRange(cy, 0, cx + 1) }
                        else if (mode === 2) { eraseRange(cy, 0, width) }
                        break
                    }
                    case "m": {
                        // SGR — retain as raw for later replay. CSI 0 m / CSI m = reset.
                        if (params === "" || params === "0") {
                            sgr = ""
                        } else {
                            sgr = `\x1b[${params}m`
                        }
                        break
                    }
                    case "s": savedCx = cx; savedCy = cy; break
                    case "u": cx = savedCx; cy = savedCy; clamp(); break
                    default: break // unknown — skip
                }
                continue
            } else if (next === "7") {
                savedCx = cx; savedCy = cy; i += 2; continue
            } else if (next === "8") {
                cx = savedCx; cy = savedCy; clamp(); i += 2; continue
            } else if (next === "(" || next === ")" || next === "*" || next === "+") {
                // charset designation, skip selector
                i += 3; continue
            } else if (next === "]") {
                // OSC — consume until BEL or ST (ESC \)
                let j = i + 2
                while (j < n) {
                    if (input.charCodeAt(j) === 0x07) { j++; break }
                    if (input.charCodeAt(j) === 0x1b && input[j + 1] === "\\") { j += 2; break }
                    j++
                }
                i = j; continue
            } else if (next === "M") {
                // reverse index
                cy--
                if (cy < 0) { cy = 0 }
                i += 2; continue
            } else {
                i += 2; continue
            }
        }

        // control chars
        if (code === 0x0a) { // \n
            cy++
            if (cy >= height) {
                scrollUp()
                cy = height - 1
            }
            i++; continue
        }
        if (code === 0x0d) { cx = 0; i++; continue } // \r
        if (code === 0x08) { // \b
            if (cx > 0) { cx-- }
            i++; continue
        }
        if (code === 0x09) { // \t — next multiple of 8
            cx = Math.min(width - 1, (Math.floor(cx / 8) + 1) * 8)
            i++; continue
        }
        if (code < 0x20 || code === 0x7f) { i++; continue }

        // printable
        putChar(c)
        i++
    }

    // render
    const lines = new Array(height)
    for (let y = 0; y < height; y++) {
        if (ansi) {
            let out = ""
            let cur = ""
            for (let x = 0; x < width; x++) {
                const cell = grid[y][x]
                if (cell.sgr !== cur) {
                    if (cur !== "") { out += "\x1b[0m" }
                    out += cell.sgr
                    cur = cell.sgr
                }
                out += cell.ch
            }
            if (cur !== "") { out += "\x1b[0m" }
            lines[y] = out
        } else {
            let out = ""
            for (let x = 0; x < width; x++) { out += grid[y][x].ch }
            lines[y] = out
        }
    }

    let result = lines.join("\n")
    if (trim) {
        // strip trailing blank lines and trailing spaces on each line
        result = result
            .split("\n")
            .map((l) => l.replace(/\s+$/, ""))
            .join("\n")
            .replace(/\n+$/, "")
    }
    return result
}

/**
 * Trim a rendered screen's trailing status bar.
 *
 * Scans the last `lookback` lines for `marker`. If found, returns
 * everything BEFORE that line (exclusive). Used by peek to drop
 * Claude Code's bottom divider / status chrome from the output.
 */
export function trimTrailingMarker(screen, marker = "─────", lookback = 10) {
    const lines = screen.split("\n")
    const start = Math.max(0, lines.length - lookback)
    for (let i = start; i < lines.length; i++) {
        if (lines[i].includes(marker)) {
            return lines.slice(0, i).join("\n")
        }
    }
    return screen
}
