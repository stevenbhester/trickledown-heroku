const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cfg = require('./config');
const { query } = require('./db');

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

function sign(user) {
  return jwt.sign({ sub: user.id, u: user.username }, cfg.jwtSecret, { expiresIn: '180d' });
}

async function hashPassword(pw) {
  return bcrypt.hash(pw, 10);
}

async function checkPassword(pw, hash) {
  if (!hash) return false;
  return bcrypt.compare(pw, hash);
}

function validUsername(u) {
  return typeof u === 'string' && USERNAME_RE.test(u) && !/^guest_/i.test(u);
}

function validPassword(p) {
  return typeof p === 'string' && p.length >= 6 && p.length <= 200;
}

// Guest handles look like guest_a7k2qz. They can be claimed later.
function guestName() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = 'guest_';
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

// Express middleware: requires a Bearer token and loads req.user.
async function requireUser(req, res, next) {
  const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  if (!m) return res.status(401).json({ error: 'Sign in to do that.' });
  let payload;
  try { payload = jwt.verify(m[1], cfg.jwtSecret); } catch (e) {
    return res.status(401).json({ error: 'Your session expired. Sign in again.' });
  }
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [payload.sub]);
  if (!rows[0]) return res.status(401).json({ error: 'That account no longer exists.' });
  req.user = rows[0];
  next();
}

module.exports = {
  sign, hashPassword, checkPassword, validUsername, validPassword, guestName, requireUser,
};
