/**
 * Image imports.
 *
 * electron-vite resolves an imported asset to a URL string at build time and inlines or
 * emits it, but TypeScript does not know that on its own — without this the brand mark
 * import is a compile error, which is how the typecheck caught it.
 *
 * `vite/client` would also supply these, and pulls in the whole `import.meta.env` surface
 * with it. This renderer reads no environment variables; two lines is the smaller promise.
 */
declare module '*.png' {
  const src: string;
  export default src;
}

declare module '*.svg' {
  const src: string;
  export default src;
}
