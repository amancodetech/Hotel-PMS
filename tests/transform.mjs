import { transformSync } from 'esbuild';
export default {
  process(source, filename) {
    return transformSync(source, {
      loader: 'tsx',
      format: 'esm',
      jsx: 'automatic',
      target: 'es2023',
      sourcemap: 'inline',
      sourcefile: filename,
    });
  },
};
