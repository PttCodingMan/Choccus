import { defineConfig, type Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const MAP_COLS = 15;
const MAP_ROWS = 13;

/** Match `const NAME_TEMPLATE: readonly string[] = [ ... ];` (the rows block). */
const templateBlock = (name: string): RegExp =>
  new RegExp(`(const\\s+${name}\\s*:\\s*readonly\\s+string\\[\\]\\s*=\\s*\\[)[\\s\\S]*?(\\n\\];)`);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => ok(buf));
    req.on('error', fail);
  });
}

/**
 * Dev-only endpoint backing public/map-editor.html: GET returns the authored map
 * templates parsed out of sim/Map.ts; POST { name, rows } splices a template back
 * into the source file in place. Only mounted under `npm run dev` (apply:'serve'),
 * so the browser edits real source with no File System Access prompt and no paste.
 */
function mapEditorPlugin(): Plugin {
  return {
    name: 'choccus-map-editor',
    apply: 'serve',
    configureServer(server) {
      const mapPath = resolve(server.config.root, 'src/sim/Map.ts');
      server.middlewares.use('/__map', async (req: IncomingMessage, res: ServerResponse) => {
        try {
          const src = await readFile(mapPath, 'utf8');
          if (req.method === 'GET') {
            const tpl: Record<string, string[]> = {};
            const re = /const\s+(\w+_TEMPLATE)\s*:\s*readonly\s+string\[\]\s*=\s*\[([\s\S]*?)\n\];/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(src))) {
              tpl[m[1]!] = (m[2]!.match(/'([^']*)'/g) ?? []).map((s) => s.slice(1, -1));
            }
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(tpl));
            return;
          }
          if (req.method === 'POST') {
            const parsed = JSON.parse(await readBody(req)) as {
              name?: unknown;
              rows?: unknown;
              create?: unknown;
            };
            const { name, rows, create } = parsed;
            // 13×15 grid of #SP.@ with exactly 4 '@' spawns (mirrors Map.ts validateTemplate).
            const validRows =
              Array.isArray(rows) &&
              rows.length === MAP_ROWS &&
              rows.every(
                (r) => typeof r === 'string' && r.length === MAP_COLS && !/[^#SP.@]/.test(r),
              ) &&
              (rows as string[]).join('').split('@').length - 1 === 4;
            if (!validRows) {
              res.statusCode = 400;
              res.end('invalid template (13 rows × 15 cols of #SP.@, exactly 4 @ spawns)');
              return;
            }
            const body = (rows as string[]).map((s) => `  '${s}',`).join('\n');

            // Create a brand-new map kind: splice a new *_TEMPLATE const + registry entry.
            if (typeof create === 'string') {
              const kind = create.toLowerCase();
              if (!/^[a-z][a-z0-9]*$/.test(kind)) {
                res.statusCode = 400;
                res.end('invalid map name (letters/digits, must start with a letter)');
                return;
              }
              const constName = `${kind.toUpperCase()}_TEMPLATE`;
              if (src.includes(constName) || new RegExp(`\\n  ${kind}:`).test(src)) {
                res.statusCode = 409;
                res.end(`map '${kind}' already exists`);
                return;
              }
              const constBlock = `const ${constName}: readonly string[] = [\n${body}\n];\n\n`;
              const out = src
                .replace(
                  /(\n\/\*\*\n \* Registry of every authored map kind)/,
                  `\n${constBlock}$1`,
                )
                .replace(
                  /(const MAP_TEMPLATES: Record<string, readonly string\[\]> = \{\n)/,
                  `$1  ${kind}: ${constName},\n`,
                );
              if (out === src) {
                res.statusCode = 500;
                res.end('could not locate the MAP_TEMPLATES registry in Map.ts');
                return;
              }
              await writeFile(mapPath, out);
              res.end('ok');
              return;
            }

            // Otherwise: edit an existing template in place.
            const re = templateBlock(name as string);
            if (typeof name !== 'string' || !re.test(src)) {
              res.statusCode = 404;
              res.end('template not found in Map.ts');
              return;
            }
            await writeFile(mapPath, src.replace(re, `$1\n${body}$2`));
            res.end('ok');
            return;
          }
          res.statusCode = 405;
          res.end();
        } catch (e) {
          res.statusCode = 500;
          res.end(e instanceof Error ? e.message : String(e));
        }
      });
    },
  };
}

export default defineConfig({
  // Base public path. Default '/' keeps dev and `npm run serve` (static at
  // root :8080) working. A subpath deploy (e.g. GitHub Pages project site at
  // /choccus/) sets VITE_BASE=/choccus/ at build time.
  base: process.env.VITE_BASE ?? '/',
  plugins: [mapEditorPlugin()],
  server: {
    fs: {
      // Allow importing ../shared (outside the client root).
      allow: ['..'],
    },
  },
});
