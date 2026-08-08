import { getStore } from '@netlify/blobs';

const KEY = 'store';
const BACKUP = 'store-prev';
const SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'];

const DEFAULTS = {
  v: 1,
  open: true,
  title: 'Bayou Legends',
  message: 'One order per family, please \u2014 add every player you\u2019re shirting for below. Shirts hand out at practice once the whole run comes back from the printer.',
  deadline: '',
  payNote: 'Pay Coach Robbie at practice — cash or Venmo. Orders are not sent to the printer until paid.',
  prices: { XS: 18, S: 18, M: 18, L: 18, XL: 18, '2XL': 20, '3XL': 21, '4XL': 22 },
  images: { front: 'assets/shirt-front.jpg', back: 'assets/shirt-back.jpg' },
  pin: null,
  orders: []
};

/* Strong consistency matters here. The default (eventual) can serve a copy of the
   store up to 60s stale, and since every action is read-modify-write, a stale read
   silently overwrites whatever was saved in between — orders vanish. */
const store = () => getStore({ name: 'shirts', consistency: 'strong' });

async function read() {
  /* Deliberately NOT wrapped in try/catch. A failed read used to fall back to an
     empty store, and the next write would then wipe every order. Letting it throw
     means the handler returns a 500 and nothing is written. */
  const d = await store().get(KEY, { type: 'json' }); // null only before the first write
  const merged = { ...DEFAULTS, ...(d || {}) };
  merged.prices = { ...DEFAULTS.prices, ...(d?.prices || {}) };
  merged.images = { ...DEFAULTS.images, ...(d?.images || {}) };
  merged.orders = Array.isArray(d?.orders) ? d.orders : [];
  return merged;
}
/* `prior` is the store exactly as it was read, before this request touched it.
   Keeping one generation back means a bad save is recoverable via 'restore'. */
async function write(d, prior) {
  if (prior) {
    try { await store().setJSON(BACKUP, prior); } catch (e) { /* backup is best-effort */ }
  }
  await store().setJSON(KEY, d);
}

const reply = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });

/* ---------- shaping ---------- */

// what any visitor may see: settings only, never other families' orders
const publicConfig = (d) => ({
  open: !!d.open,
  title: d.title,
  message: d.message,
  deadline: d.deadline,
  payNote: d.payNote,
  prices: d.prices,
  images: d.images,
  sizes: SIZES,
  pinSet: !!(process.env.COACH_PIN || d.pin)
});

const NAME_RE = /^[A-Za-z][A-Za-z'\u2019\-. ]{0,29}$/;

const tidy = (s) =>
  String(s ?? '').trim().replace(/\s+/g, ' ').split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

function cleanSizes(input) {
  const out = {};
  let count = 0;
  for (const s of SIZES) {
    const n = Number(input?.[s] ?? 0);
    if (!Number.isInteger(n) || n < 0 || n > 25) return null;
    if (n > 0) { out[s] = n; count += n; }
  }
  return count > 0 && count <= 60 ? out : null;
}

const money = (d, sizes) =>
  Math.round(Object.entries(sizes)
    .reduce((sum, [s, n]) => sum + (Number(d.prices[s]) || 0) * n, 0) * 100) / 100;

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode(d) {
  for (let tries = 0; tries < 60; tries++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!d.orders.some((o) => o.code === c)) return c;
  }
  return 'B' + Date.now().toString(36).slice(-4).toUpperCase();
}

/* one child's name + optional jersey number */
function cleanPlayers(input) {
  const list = Array.isArray(input) ? input : [];
  if (list.length === 0) return { error: 'Add at least one player.' };
  if (list.length > 8) return { error: 'That\u2019s a lot of players for one order \u2014 split it into two.' };

  const out = [];
  for (const raw of list) {
    const name = tidy(raw && raw.name);
    if (!NAME_RE.test(name)) return { error: 'Enter each player\u2019s name using letters only.' };

    const rawNum = String((raw && raw.number) ?? '').trim();
    let number = null;
    if (rawNum !== '') {
      const n = Number(rawNum);
      if (!Number.isInteger(n) || n < 0 || n > 99) return { error: 'Jersey numbers have to be a whole number from 0 to 99.' };
      number = n;
    }
    out.push({ name, number });
  }
  return { ok: true, players: out };
}

/* validate the family-facing fields, returning {ok} or {error} */
function validate(body, d) {
  const p = cleanPlayers(body.players);
  if (p.error) return { error: p.error };

  const parent = tidy(body.parent);
  if (!NAME_RE.test(parent)) return { error: 'Enter the parent\u2019s name using letters only.' };

  const contact = String(body.contact ?? '').trim().slice(0, 60);
  if (contact.length < 6) return { error: 'Add a phone number or email so the coach can reach you.' };

  const sizes = cleanSizes(body.sizes);
  if (!sizes) return { error: 'Choose at least one shirt.' };

  const note = String(body.note ?? '').trim().slice(0, 200);

  return { ok: true, players: p.players, parent, contact, sizes, note, total: money(d, sizes) };
}

function pinOk(d, pin) {
  const supplied = String(pin ?? '').trim();
  if (!supplied) return false;
  if (process.env.COACH_PIN) return supplied === process.env.COACH_PIN;
  return d.pin ? supplied === d.pin : false;
}

/* ---------- handler ---------- */

export default async (req) => {
  if (req.method !== 'POST') return reply({ error: 'Use POST.' }, 405);

  let body;
  try { body = await req.json(); } catch (e) { return reply({ error: 'Bad request.' }, 400); }
  const action = body.action;

  try {
    const d = await read();
    const prior = JSON.parse(JSON.stringify(d)); // untouched copy, for the backup slot

    /* ----- open to everyone ----- */

    if (action === 'get') return reply({ config: publicConfig(d) });

    if (action === 'lookup') {
      const code = String(body.code ?? '').trim().toUpperCase();
      const order = d.orders.find((o) => o.code === code);
      if (!order) return reply({ error: 'No order matches that code.' }, 404);
      return reply({ config: publicConfig(d), order });
    }

    if (action === 'submit') {
      if (!d.open) return reply({ error: 'Ordering is closed. Text the coach if you still need shirts.' }, 403);
      const v = validate(body, d);
      if (v.error) return reply({ error: v.error }, 400);

      const order = {
        id: 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        code: newCode(d),
        players: v.players, parent: v.parent, contact: v.contact,
        sizes: v.sizes, note: v.note, total: v.total, paid: false,
        at: new Date().toISOString()
      };
      d.orders.push(order);
      await write(d, prior);
      return reply({ ok: true, order, config: publicConfig(d) });
    }

    if (action === 'update') {
      if (!d.open) return reply({ error: 'Ordering is closed, so this order is locked. Text the coach for a change.' }, 403);
      const code = String(body.code ?? '').trim().toUpperCase();
      const i = d.orders.findIndex((o) => o.code === code);
      if (i < 0) return reply({ error: 'No order matches that code.' }, 404);
      if (d.orders[i].paid) return reply({ error: 'This order is marked paid. Ask the coach to change it.' }, 403);
      const v = validate(body, d);
      if (v.error) return reply({ error: v.error }, 400);

      d.orders[i] = {
        ...d.orders[i],
        players: v.players, parent: v.parent, contact: v.contact,
        sizes: v.sizes, note: v.note, total: v.total,
        editedAt: new Date().toISOString()
      };
      await write(d, prior);
      return reply({ ok: true, order: d.orders[i], config: publicConfig(d) });
    }

    if (action === 'cancel') {
      if (!d.open) return reply({ error: 'Ordering is closed. Text the coach to cancel.' }, 403);
      const code = String(body.code ?? '').trim().toUpperCase();
      const i = d.orders.findIndex((o) => o.code === code);
      if (i < 0) return reply({ error: 'No order matches that code.' }, 404);
      if (d.orders[i].paid) return reply({ error: 'This order is marked paid. Ask the coach to cancel it.' }, 403);
      d.orders.splice(i, 1);
      await write(d, prior);
      return reply({ ok: true });
    }

    /* ----- coach only ----- */

    if (action === 'auth') {
      const supplied = String(body.pin ?? '').trim();
      if (supplied.length < 4) return reply({ error: 'Use a PIN of at least 4 characters.' }, 400);
      if (!process.env.COACH_PIN && !d.pin) {       // first run: this PIN becomes the PIN
        d.pin = supplied;
        await write(d, prior);
        return reply({ ok: true, firstRun: true, config: publicConfig(d), orders: d.orders });
      }
      if (!pinOk(d, supplied)) return reply({ error: 'That PIN did not match.' }, 401);
      return reply({ ok: true, config: publicConfig(d), orders: d.orders });
    }

    if (!pinOk(d, body.pin)) return reply({ error: 'That PIN did not match.' }, 401);
    const done = async () => {
      await write(d, prior);
      return reply({ ok: true, config: publicConfig(d), orders: d.orders });
    };

    /* Undo the most recent write. Deliberately does not touch the backup slot,
       so calling it twice in a row is a no-op rather than a ping-pong. */
    if (action === 'restore') {
      const b = await store().get(BACKUP, { type: 'json' });
      if (!b || !Array.isArray(b.orders)) return reply({ error: 'Nothing to roll back to yet.' }, 404);
      const restored = { ...DEFAULTS, ...b };
      restored.prices = { ...DEFAULTS.prices, ...(b.prices || {}) };
      restored.images = { ...DEFAULTS.images, ...(b.images || {}) };
      await store().setJSON(KEY, restored);
      return reply({
        ok: true,
        restored: restored.orders.length,
        config: publicConfig(restored),
        orders: restored.orders
      });
    }

    if (action === 'settings') {
      const s = body.settings || {};
      if (typeof s.open === 'boolean') d.open = s.open;
      for (const k of ['title', 'message', 'deadline', 'payNote']) {
        if (typeof s[k] === 'string') d[k] = s[k].trim().slice(0, 400);
      }
      if (s.prices) {
        for (const size of SIZES) {
          const p = Number(s.prices[size]);
          if (!Number.isFinite(p) || p < 0 || p > 500) return reply({ error: `Price for ${size} must be between 0 and 500.` }, 400);
          d.prices[size] = Math.round(p * 100) / 100;
        }
      }
      if (s.images) {
        for (const side of ['front', 'back']) {
          if (typeof s.images[side] === 'string' && s.images[side].trim()) {
            d.images[side] = s.images[side].trim().slice(0, 300);
          }
        }
      }
      // existing totals follow the new prices
      d.orders = d.orders.map((o) => ({ ...o, total: money(d, o.sizes) }));
      return done();
    }

    if (action === 'add') {
      const v = validate(body, d);
      if (v.error) return reply({ error: v.error }, 400);
      d.orders.push({
        id: 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        code: newCode(d),
        players: v.players, parent: v.parent, contact: v.contact,
        sizes: v.sizes, note: v.note, total: v.total, paid: !!body.paid,
        at: new Date().toISOString(), byCoach: true
      });
      return done();
    }

    if (action === 'edit') {
      const i = d.orders.findIndex((o) => o.id === body.id);
      if (i < 0) return reply({ error: 'That order is no longer here.' }, 404);
      const v = validate(body, d);
      if (v.error) return reply({ error: v.error }, 400);
      d.orders[i] = {
        ...d.orders[i],
        players: v.players, parent: v.parent, contact: v.contact,
        sizes: v.sizes, note: v.note, total: v.total,
        editedAt: new Date().toISOString()
      };
      return done();
    }

    if (action === 'paid') {
      const i = d.orders.findIndex((o) => o.id === body.id);
      if (i < 0) return reply({ error: 'That order is no longer here.' }, 404);
      d.orders[i].paid = !!body.paid;
      return done();
    }

    if (action === 'delete') {
      const i = d.orders.findIndex((o) => o.id === body.id);
      if (i < 0) return reply({ error: 'That order is no longer here.' }, 404);
      d.orders.splice(i, 1);
      return done();
    }

    if (action === 'reset') {
      if (String(body.confirm ?? '') !== 'CLEAR') return reply({ error: 'Type CLEAR to empty the store.' }, 400);
      d.orders = [];
      return done();
    }

    return reply({ error: 'Unknown action.' }, 400);
  } catch (e) {
    return reply({ error: 'The store is unreachable right now. Try again in a moment.' }, 500);
  }
};
