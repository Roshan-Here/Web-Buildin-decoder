/*
 * Writes a PGS subtitle stream for the browser check: every ten seconds, a yellow box from 1 s
 * to 4 s near the bottom of an 854 × 480 canvas. Run by `npm run fixtures` (Node 22.6 or later).
 */
import { writeFileSync } from 'node:fs'
import { boxPixels, writeSup, type PgsDisplaySetSpec } from '../test/picture-subs/pgs-writer.ts'

const palette = new Map([
  [0, { r: 0, g: 0, b: 0, a: 0 }],
  [1, { r: 255, g: 220, b: 0, a: 255 }],
  [2, { r: 0, g: 0, b: 0, a: 255 }],
])
const sets: PgsDisplaySetSpec[] = []
let n = 0
for (let base = 0; base < 30; base += 10) {
  const at = (time: number, objects: PgsDisplaySetSpec['objects']) =>
    sets.push({
      time: base + time,
      width: 854,
      height: 480,
      compositionNumber: n++,
      palette,
      objects,
    })
  at(1, [{ x: 277, y: 400, width: 300, height: 48, pixels: boxPixels(300, 48, 1, 2) }])
  at(4, [])
}
writeFileSync(process.argv[2] ?? 'picture-subs.sup', writeSup(sets))
