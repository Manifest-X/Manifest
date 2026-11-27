// Shared ES modules (.mjs) are inlined into bundles as bare declarations
export function inlineSubscript(filePath, content) {
    if (!filePath.endsWith('.mjs')) return content;
    const bare = content.replace(/^export (?=(?:const|let|var|class|function\*?|async function\*?)\s)/gm, '');
    const left = bare.match(/^export\b.*$/m);
    if (left) throw new Error(`${filePath}: cannot inline "${left[0]}" (only export const|let|var|class|function declarations)`);
    return bare;
}
