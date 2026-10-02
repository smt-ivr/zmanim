// Minimal path router with :params. Each route declares whether it needs authentication.

export class Router {
  #routes = [];

  add(method, path, handler, { auth = true } = {}) {
    const keys = [];
    const source = path.replace(/:([A-Za-z_]+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    });
    this.#routes.push({ method, pattern: new RegExp(`^${source}/?$`), keys, handler, auth });
    return this;
  }

  get = (path, handler, opts) => this.add('GET', path, handler, opts);
  post = (path, handler, opts) => this.add('POST', path, handler, opts);
  patch = (path, handler, opts) => this.add('PATCH', path, handler, opts);
  delete = (path, handler, opts) => this.add('DELETE', path, handler, opts);

  // Returns { route, params } or { allowed: [methods] } when the path exists with other methods
  match(method, pathname) {
    const allowed = new Set();
    for (const route of this.#routes) {
      const m = route.pattern.exec(pathname);
      if (!m) continue;
      if (route.method === method) {
        const params = {};
        route.keys.forEach((key, i) => {
          try {
            params[key] = decodeURIComponent(m[i + 1]);
          } catch {
            params[key] = m[i + 1];
          }
        });
        return { route, params };
      }
      allowed.add(route.method);
    }
    return { allowed: [...allowed] };
  }
}
