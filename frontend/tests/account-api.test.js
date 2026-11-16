import test from 'node:test'
import assert from 'node:assert/strict'
import { AccountError, deleteAccount, normalizePhone, profileErrors, register, registrationErrors, signIn, updateProfile } from '../src/account-api.js'
import { translations } from '../src/i18n.js'

const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const valid = { name: 'خالد الرميزان', email: 'Khaled@Example.com', phone: '050 123 4567', password: 'secret123', confirm: 'secret123', user_type: 'citizen' }

test('US-02 valid registration details pass client checks', () => {
  assert.deepEqual(registrationErrors(valid), {})
  assert.deepEqual(registrationErrors({ ...valid, name: 'Khaled Alrumayzan', phone: '+44 7700 900123', user_type: 'pilgrim' }), {})
})

test('US-02 invalid registration details are reported per field', () => {
  assert.deepEqual(registrationErrors({ name: 'K1', email: 'bad@', phone: '12345', password: 'password', confirm: 'other', user_type: 'admin' }), {
    name: 'nameInvalid', email: 'emailInvalid', phone: 'phoneInvalid', password: 'passwordWeak', confirm: 'passwordMismatch', user_type: 'userTypeInvalid',
  })
  assert.deepEqual(registrationErrors({ name: '', email: '', phone: '', password: '', confirm: '', user_type: '' }), {
    name: 'fieldRequired', email: 'fieldRequired', phone: 'fieldRequired', password: 'fieldRequired', user_type: 'fieldRequired',
  })
})

test('phone numbers are normalized like the backend', () => {
  assert.equal(normalizePhone('0501234567'), '+966501234567')
  assert.equal(normalizePhone('+966 50 123 4567'), '+966501234567')
  assert.equal(normalizePhone('0401234567'), null)
})

test('US-06 profile checks only editable fields', () => {
  assert.deepEqual(profileErrors({ name: 'Khaled', phone: '0551112222', user_type: 'resident' }), {})
  assert.deepEqual(profileErrors({ name: '', phone: 'x', user_type: '' }), { name: 'fieldRequired', phone: 'phoneInvalid', user_type: 'fieldRequired' })
})

test('US-01 register sends only account fields and language', async () => {
  let sent
  const result = await register(valid, 'en', async (url, options) => { sent = { url, options }; return response({ email: 'khaled@example.com', code_sent: true }, 201) })
  assert.equal(sent.url, '/api/auth/register')
  assert.deepEqual(JSON.parse(sent.options.body), { name: valid.name, email: valid.email, phone: valid.phone, password: valid.password, user_type: 'citizen', language: 'en' })
  assert.equal(result.code_sent, true)
})

test('US-03 duplicate fields map to translated messages', async () => {
  const failure = await register(valid, 'ar', async () => response({ detail: { code: 'ACCOUNT_EXISTS', fields: { email: 'EMAIL_TAKEN' } } }, 409)).catch((error) => error)
  assert.ok(failure instanceof AccountError)
  assert.equal(failure.code, 'accountExists')
  assert.deepEqual(failure.fields, { email: 'emailTaken' })
})

test('US-04 and US-05 sign-in errors are distinguished', async () => {
  const unverified = await signIn('a@b.co', 'x', async () => response({ detail: { code: 'ACCOUNT_NOT_VERIFIED' } }, 403)).catch((error) => error)
  assert.equal(unverified.code, 'notVerified')
  const wrong = await signIn('a@b.co', 'x', async () => response({ detail: { code: 'INVALID_CREDENTIALS' } }, 401)).catch((error) => error)
  assert.equal(wrong.code, 'invalidCredentials')
  const offline = await signIn('a@b.co', 'x', async () => { throw new TypeError('offline') }).catch((error) => error)
  assert.equal(offline.code, 'network')
})

test('US-06 and US-07 send the session token', async () => {
  const calls = []
  const fetcher = async (url, options) => { calls.push({ url, options }); return response({}) }
  await updateProfile('token-1', { name: 'Khaled', phone: '0551112222', user_type: 'resident', email: 'ignored@example.com' }, fetcher)
  await deleteAccount('token-1', 'secret123', fetcher)
  assert.deepEqual(calls.map((call) => [call.url, call.options.method, call.options.headers.Authorization]), [
    ['/api/profile', 'PATCH', 'Bearer token-1'], ['/api/profile', 'DELETE', 'Bearer token-1'],
  ])
  assert.deepEqual(JSON.parse(calls[0].options.body), { name: 'Khaled', phone: '0551112222', user_type: 'resident' })
})

test('every account message exists in both languages', () => {
  const keys = ['accountExists', 'emailTaken', 'phoneTaken', 'notVerified', 'invalidCredentials', 'codeExpired', 'passwordWrong', 'userType_pilgrim']
  for (const language of ['ar', 'en']) for (const key of keys) assert.ok(translations[language][key], `${language}.${key}`)
})
