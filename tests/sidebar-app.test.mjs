import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInventoryServer } from '../src/server.mjs';

async function app(t) {
  const directory = await mkdtemp(join(tmpdir(), 'inventory-sidebar-'));
  const databasePath = join(directory, 'inventory.sqlite');
  const server = createInventoryServer({ databasePath });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const get = (path) => fetch(url + path, { headers: { cookie }, redirect: 'manual' });
  const post = (path, fields) => fetch(url + path, {
    method: 'POST', headers: { cookie }, redirect: 'manual',
    body: new URLSearchParams(fields),
  });
  const token = (html, name = 'csrfToken') => html.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1];
  const setup = await (await get('/')).text();
  const login = await post('/setup', { setupToken: token(setup, 'setupToken'), username: 'admin', password: 'marina-segura-123' });
  cookie = login.headers.get('set-cookie').split(';')[0];
  const csrfToken = token(await (await get('/products')).text());
  const signIn = async (username, password) => {
    const response = await post('/login', { username, password });
    cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  };
  return { get, post, csrfToken, signIn };
}

const sidebarOf = (html) => html.match(/<aside class="sidebar"[\s\S]*?<\/aside>/)?.[0] ?? '';
const linksOf = (sidebar) => [...sidebar.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)].map((match) => match[0]);
const textOf = (anchor) => anchor.replace(/<[^>]+>/g, '').trim();
const hrefOf = (anchor) => anchor.match(/href="([^"]+)"/)?.[1];
const isActive = (anchor) => /aria-current="page"/.test(anchor) && /is-active/.test(anchor);

test('el lateral conserva los destinos actuales y suma Clientes', async (t) => {
  const a = await app(t);
  const sidebar = sidebarOf(await (await a.get('/products')).text());
  const links = linksOf(sidebar);

  const nav = links.map((anchor) => ({ href: hrefOf(anchor), label: textOf(anchor) }));
  assert.deepEqual(nav, [
    { href: '/products', label: 'Productos' },
    { href: '/inventory', label: 'Inventario' },
    { href: '/purchase-orders', label: 'Órdenes de compra' },
    { href: '/orders', label: 'Pedidos' },
    { href: '/drafts', label: 'Borradores' },
    { href: '/customers', label: 'Clientes' },
    { href: '/users', label: 'Cuentas y permisos' },
    { href: '/backups', label: 'Copias de seguridad' },
  ]);
});

test('el estilo Shopify trae iconos, pastilla activa y la administración abajo', async (t) => {
  const a = await app(t);
  const sidebar = sidebarOf(await (await a.get('/products')).text());

  const topLevel = ['Productos', 'Pedidos', 'Clientes', 'Cuentas y permisos', 'Copias de seguridad'];
  for (const anchor of linksOf(sidebar)) {
    const label = textOf(anchor);
    if (topLevel.includes(label)) assert.match(anchor, /<span class="sidebar-icon" aria-hidden="true"><svg/, label);
    else assert.doesNotMatch(anchor, /sidebar-icon/, label);
  }
  for (const anchor of linksOf(sidebar).filter((entry) => /sidebar-child/.test(entry))) {
    assert.match(anchor, /sidebar-child/);
  }
  // Productos y Pedidos son grupos plegables con su botón de despliegue.
  assert.equal([...sidebar.matchAll(/data-sidebar-group/g)].length, 2);
  assert.equal([...sidebar.matchAll(/data-sidebar-toggle/g)].length, 2);
  assert.match(sidebar, /<p class="sidebar-section-title">Configuración<\/p>/);
  // La administración va después de los destinos principales, como Configuración.
  assert.ok(sidebar.indexOf('>Clientes<') < sidebar.indexOf('>Configuración<'));
});

test('cada ruta deja activa su enlace, con aria-current y pastilla', async (t) => {
  const a = await app(t);
  const routes = [
    ['/products', '/products'],
    ['/inventory', '/inventory'],
    ['/purchase-orders', '/purchase-orders'],
    ['/orders', '/orders'],
    ['/drafts', '/drafts'],
    ['/customers', '/customers'],
    ['/users', '/users'],
    ['/backups', '/backups'],
  ];
  for (const [path, href] of routes) {
    const sidebar = sidebarOf(await (await a.get(path)).text());
    const active = linksOf(sidebar).filter(isActive);
    assert.equal(active.length, 1, `${path} resalta un solo enlace`);
    assert.equal(hrefOf(active[0]), href, `${path} resalta ${href}`);
  }
});

test('Consulta ve Clientes pero no la administración', async (t) => {
  const a = await app(t);
  assert.equal((await a.post('/users', { csrfToken: a.csrfToken, username: 'consulta', password: 'consulta-segura-123', role: 'viewer' })).status, 303);
  await a.signIn('consulta', 'consulta-segura-123');
  const sidebar = sidebarOf(await (await a.get('/products')).text());
  const hrefs = linksOf(sidebar).map(hrefOf);
  assert.deepEqual(hrefs, ['/products', '/inventory', '/purchase-orders', '/orders', '/drafts', '/customers']);
  assert.doesNotMatch(sidebar, /Configuración|Cuentas y permisos|Copias de seguridad/);
});
