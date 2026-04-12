/**
 * Human-friendly session name generator.
 * Produces camelCase names like "calmLion", "swiftFox", "braveWolf"
 * by combining an adjective + animal from unique-names-generator's
 * built-in dictionaries.
 */

import { uniqueNamesGenerator, nameAdjectives, nameAnimals } from "../imports.js"

export function generateName() {
    // `capital` style + empty separator yields PascalCase ("CalmLion");
    // lowercase the first char to get the camelCase form.
    const name = uniqueNamesGenerator({
        dictionaries: [nameAdjectives, nameAnimals],
        style: "capital",
        separator: "",
        length: 2,
    })
    return name[0].toLowerCase() + name.slice(1)
}
