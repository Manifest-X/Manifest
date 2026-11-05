/**
 * @template T
 * @param {(...args: any[]) => import('mnfst').ManifestComponent<T>} factory
 * @returns {(...args: any[]) => T}
 */
export const component = (factory) => factory
