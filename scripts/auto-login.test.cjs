const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLoginEnvironment, validateTicketEndpoint } = require('../src/auto-login');
test('simultaneous client launches keep account tickets separate without changing the parent environment', () => {
  const parent = { PATH: 'unchanged', BRULUNA_LOGIN_TICKET: 'stale' };
  const a = createLoginEnvironment(parent, { account: 'AccountA', ticket: 'abcdefgh2345' });
  const b = createLoginEnvironment(parent, { account: 'AccountB', ticket: 'ijklmnop6789' });
  assert.equal(a.BRULUNA_LOGIN_ACCOUNT, 'AccountA'); assert.equal(b.BRULUNA_LOGIN_ACCOUNT, 'AccountB');
  assert.notEqual(a.BRULUNA_LOGIN_TICKET, b.BRULUNA_LOGIN_TICKET);
  assert.equal(parent.BRULUNA_LOGIN_TICKET, 'stale');
  assert.equal(createLoginEnvironment(parent, null).BRULUNA_LOGIN_TICKET, undefined);
  assert.throws(() => createLoginEnvironment(parent, { account: 'A\nB', ticket: 'abcdefgh2345' }));
  assert.throws(() => createLoginEnvironment(parent, { account: 'A', ticket: 'password' }));
  assert.throws(() => validateTicketEndpoint('http://example.com/ticket'));
  assert.throws(() => validateTicketEndpoint('https://user:pass@example.com/ticket'));
  assert.equal(validateTicketEndpoint('https://example.com/api/game/launcher-ticket').protocol, 'https:');
});
test('account controls and event bindings exist together; no shared INI ticket handoff remains', () => {
  const src = path.join(__dirname, '../src');
  const html = fs.readFileSync(path.join(src, 'index.html'), 'utf8');
  for (const id of ['accountPanel','accountLoginForm','accountUsernameInput','accountPasswordInput','accountRememberInput','accountLoginButton','accountForgotButton','accountRegisterButton','accountLogoutButton','accountPicker','accountWelcome','accountList','accountStatus']) assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, id);
  const main = fs.readFileSync(path.join(src, 'main.js'), 'utf8');
  assert(!main.includes('writeLauncherAutoLoginConfig')); assert(main.includes('env: createLoginEnvironment(process.env, loginTicket)'));
});
