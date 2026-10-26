import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Preserve the existing template and synchronous script order while allowing
// browsers to reuse byte-identical code and styles across page loads.
export function createPageAssets(files = []) {
  const assets = new Map();
  const replacements = new Map();
  function register(name, body, contentType) {
    const digest = createHash('sha256').update(body).digest('hex');
    const url = `/assets/${digest}/${name}`;
    if (!assets.has(url)) assets.set(url, { body, contentType });
    return url;
  }
  for (const { route, path, contentType } of files) {
    replacements.set(route, register(route.slice(1), readFileSync(path), contentType));
  }
  return {
    get(url) { return assets.get(url); },
    render(html) {
      // The small theme bootstrap stays inline to avoid a theme flash. The
      // template has only two auth states and three saved theme modes, so main
      // scripts form a bounded set even though their initial state differs.
      const extracted = html.replace(/<script>([\s\S]*?)<\/script>/g, (tag, body) => (
        body.length < 64 * 1024 ? tag : `<script src="${register('app.js', body, 'text/javascript')}"></script>`
      ));
      return extracted.replace(/\b(src|href)="([^"?]+)(?:\?[^"\n]*)?"/g, (tag, attribute, route) => (
        replacements.has(route) ? `${attribute}="${replacements.get(route)}"` : tag
      ));
    },
  };
}
