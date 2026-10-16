import type { Plugin } from 'vite';

/**
 * Builds one self-contained HTML file: the entry's script and stylesheet are inlined into the page and
 * every asset (the engine's .wasm, fonts, the worker) is inlined into the script as a data URL.
 *
 * Used by the MCP Apps canvas (vite.mcp.config.ts) and the VS Code webview (vscode/vite.webview.config.mts).
 * It replaces vite-plugin-singlefile, which pulls in micromatch → braces for a glob option this repository
 * never sets; braces has an open advisory with no fixed release (GHSA-vfj7-8cjw-p6xm).
 */
export function singleFile(): Plugin {
  return {
    name: 'hindcast:single-file',
    enforce: 'post',
    config: () => ({
      base: './',
      build: {
        assetsInlineLimit: () => true,
        chunkSizeWarningLimit: 100_000_000,
        cssCodeSplit: false,
        assetsDir: '',
        rolldownOptions: { output: { codeSplitting: false } },
      },
      // workers stay files of their own, but each in one piece (no stray chunks next to the page)
      worker: { rolldownOptions: { output: { codeSplitting: false } } },
    }),
    generateBundle(_options, bundle) {
      const html = Object.keys(bundle).filter((f) => /\.html?$/.test(f));
      const inlined = new Set<string>();
      for (const page of html) {
        const chunk = bundle[page];
        if (chunk.type !== 'asset') continue;
        let source = String(chunk.source);
        for (const [file, out] of Object.entries(bundle)) {
          const name = escape(out.fileName);
          if (out.type === 'chunk' && /\.[mc]?js$/.test(file)) {
            const code = out.code.replace(/"?__VITE_PRELOAD__"?/g, 'void 0').replace(/<(\/script>|!--)/g, '\\x3C$1').trim();
            const tag = new RegExp(`<script([^>]*?) src="(?:[^"]*?/)?${name}"([^>]*)></script>`);
            if (tag.test(source)) {
              source = source.replace(tag, (_, before, after) => `<script${before}${after}>${code}</script>`);
              inlined.add(file);
            }
          } else if (out.type === 'asset' && /\.css$/.test(file)) {
            const css = String(out.source).replace('@charset "UTF-8";', '').trim();
            const tag = new RegExp(`<link([^>]*?) href="(?:[^"]*?/)?${name}"([^>]*)>`);
            if (tag.test(source)) {
              source = source.replace(tag, (_, before, after) => `<style${before}${after}>${css}</style>`);
              inlined.add(file);
            }
          }
        }
        chunk.source = source;
      }
      for (const file of inlined) delete bundle[file];
      for (const file of Object.keys(bundle)) if (!html.includes(file)) this.info(`kept as a file: ${file}`);
    },
  };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
