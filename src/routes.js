import { Router } from './router.js';
import * as authH from './handlers/auth.js';
import * as publicH from './handlers/public.js';
import * as metaH from './handlers/meta.js';
import * as synagoguesH from './handlers/synagogues.js';
import * as locationsH from './handlers/locations.js';
import * as minyanimH from './handlers/minyanim.js';
import * as usersH from './handlers/users.js';
import * as rolesH from './handlers/roles.js';
import { registerLookupRoutes } from './handlers/lookups.js';

const r = new Router();
const open = { auth: false };

// ---- Public (no token) -----------------------------------------------------
r.get('/health', publicH.health, open);
r.get('/public/minyanim', publicH.minyanim, open);
r.get('/public/synagogues', publicH.synagogues, open);

// ---- Authentication --------------------------------------------------------
r.post('/auth/login', authH.login, open);
r.post('/auth/logout', authH.logout);
r.post('/auth/logout-all', authH.logoutAll);
r.post('/auth/change-password', authH.changePassword);
r.get('/auth/me', authH.me);

// ---- Reference data & catalogs --------------------------------------------
r.get('/meta', metaH.get);
r.get('/permissions', rolesH.permissionCatalog);

// ---- Core resources --------------------------------------------------------
r.get('/synagogues', synagoguesH.list);
r.post('/synagogues', synagoguesH.create);
r.get('/synagogues/:id', synagoguesH.get);
r.patch('/synagogues/:id', synagoguesH.update);
r.delete('/synagogues/:id', synagoguesH.remove);

r.get('/locations', locationsH.list);
r.post('/locations', locationsH.create);
r.get('/locations/:id', locationsH.get);
r.patch('/locations/:id', locationsH.update);
r.delete('/locations/:id', locationsH.remove);

r.get('/minyanim', minyanimH.list);
r.post('/minyanim', minyanimH.create);
r.get('/minyanim/:id', minyanimH.get);
r.patch('/minyanim/:id', minyanimH.update);
r.delete('/minyanim/:id', minyanimH.remove);

// ---- Administration --------------------------------------------------------
r.get('/users', usersH.list);
r.post('/users', usersH.create);
r.get('/users/:id', usersH.get);
r.patch('/users/:id', usersH.update);
r.delete('/users/:id', usersH.remove);

r.get('/roles', rolesH.list);
r.post('/roles', rolesH.create);
r.get('/roles/:id', rolesH.get);
r.patch('/roles/:id', rolesH.update);
r.delete('/roles/:id', rolesH.remove);

// /areas, /prayer-types, /time-types, /seasons
registerLookupRoutes(r);

export default r;
