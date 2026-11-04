export interface CsvField { raw: string; value: string }
export function tokenizeRow(line: string): CsvField[]
export function quoteField(value: string): string
export function placeholders(text: string): string[]
export function samePlaceholders(a: string, b: string): boolean
export function mergeTranslations(
  csvText: string,
  lang: string,
  updates: Record<string, string>,
): {
  text: string
  changed: { key: string; before: string; after: string }[]
  unchanged: string[]
  errors: string[]
}
export function extractRows(csvText: string, extraLangs?: string[]): Array<Record<string, string> & { key: string }>
