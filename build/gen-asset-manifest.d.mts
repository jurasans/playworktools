export interface AssetScan {
  sfx: Record<string, string>
  music: Record<string, string>
  audioFiles: Record<string, string[]>
  imageFiles: Record<string, string[]>
  videoFiles: Record<string, string[]>
  variants: Record<string, number>
  errors: string[]
  warnings: string[]
}
export const ROOT: string
export const PUBLIC_DIR: string
export const OUT_PATH: string
export function scanAssets(publicDir?: string): AssetScan
export function renderManifest(scan: AssetScan): string
export function generate(): { source: string; scan: AssetScan; upToDate: boolean }
