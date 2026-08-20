#!/usr/bin/env node
// Transcrypt a Chromium Cookies DB in place: decrypt v10 values with the
// source browser's Keychain key, re-encrypt with the target browser's key.
// macOS Chromium scheme: AES-128-CBC, key = PBKDF2-SHA1(keychain_pw,
// 'saltysalt', 1003, 16), IV = 16 spaces, plaintext prefixed with
// SHA256(host_key) since schema v24 (used here to verify decryption).
//
// Usage: transcrypt-cookies.js <cookies-db>
// Env:   FLOW_BROWSER_SRC_KEYCHAIN  "service:account" (default Helium)
//        FLOW_BROWSER_DST_KEYCHAIN  "service:account" (default Chromium)
'use strict';
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function keychainKey(spec, hint) {
  const sep = spec.lastIndexOf(':');
  const service = spec.slice(0, sep);
  const account = spec.slice(sep + 1);
  let password;
  try {
    password = execFileSync(
      'security', ['find-generic-password', '-s', service, '-a', account, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch {
    console.error(`transcrypt: Keychain item not found: "${service}" (${account}). ${hint}`);
    process.exit(1);
  }
  return crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
}

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('usage: transcrypt-cookies.js <cookies-db>');
  process.exit(2);
}

const srcKey = keychainKey(
  process.env.FLOW_BROWSER_SRC_KEYCHAIN || 'Helium Storage Key:Helium',
  'Is the source browser installed and has it stored cookies?',
);
const dstKey = keychainKey(
  process.env.FLOW_BROWSER_DST_KEYCHAIN || 'Chromium Safe Storage:Chromium',
  'Run flow-browser-start once so CloakBrowser creates its encryption key.',
);
const iv = Buffer.alloc(16, ' ');

const db = new DatabaseSync(dbPath);
const rows = db.prepare('SELECT rowid, host_key, encrypted_value FROM cookies').all();
const update = db.prepare('UPDATE cookies SET encrypted_value = ? WHERE rowid = ?');
const remove = db.prepare('DELETE FROM cookies WHERE rowid = ?');
let reEncrypted = 0;
let dropped = 0;
let plaintextKept = 0;

for (const row of rows) {
  const blob = row.encrypted_value;
  if (!blob || blob.length === 0) {
    plaintextKept += 1;
    continue;
  }
  const buf = Buffer.from(blob);
  let plain = null;
  if (buf.subarray(0, 3).toString('latin1') === 'v10') {
    try {
      const decipher = crypto.createDecipheriv('aes-128-cbc', srcKey, iv);
      const candidate = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]);
      const domainHash = crypto.createHash('sha256').update(row.host_key).digest();
      if (candidate.subarray(0, 32).equals(domainHash)) plain = candidate;
    } catch {
      // wrong key or corrupt value: drop below
    }
  }
  if (plain === null) {
    remove.run(row.rowid);
    dropped += 1;
    continue;
  }
  const cipher = crypto.createCipheriv('aes-128-cbc', dstKey, iv);
  const encrypted = Buffer.concat([Buffer.from('v10'), cipher.update(plain), cipher.final()]);
  update.run(encrypted, row.rowid);
  reEncrypted += 1;
}
db.close();
console.log(`transcrypt: ${reEncrypted} re-encrypted, ${dropped} dropped, ${plaintextKept} plaintext kept, total ${rows.length}`);
