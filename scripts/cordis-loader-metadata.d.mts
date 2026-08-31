/** Parse one Cordis Loader YAML document while retaining `!!js` expressions. */
export function parseLoaderConfig(text: string): unknown

/** Return every unsupported `!!js` expression found in Loader metadata. */
export function validateLoaderMetadata(document: unknown, file: string): string[]
