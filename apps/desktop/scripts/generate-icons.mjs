/**
 * Rasterize the Web GUI favicon (`apps/web/public/favicon.svg`) into the
 * desktop icons: `build/icon.png` (256px, as-is) and `build/tray-icon.png`
 * (32px, white for dark Windows taskbars). Runs under plain Node with
 * `@resvg/resvg-js`; run once with `pnpm run icons` and commit the outputs —
 * electron-builder and the tray need static files.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))
const faviconPath = join(packageDir, '..', 'web', 'public', 'favicon.svg')

const ICONS = [
  { file: 'icon.png', size: 256, fill: '#000' },
  { file: 'tray-icon.png', size: 32, fill: '#fff' },
]

const source = await readFile(faviconPath, 'utf8')
await mkdir(join(packageDir, 'build'), { recursive: true })
for (const icon of ICONS) {
  const svg = source.replaceAll('#000', icon.fill)
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: icon.size } }).render().asPng()
  await writeFile(join(packageDir, 'build', icon.file), png)
  console.log(`generated ${icon.file} (${png.length} bytes)`)
}
