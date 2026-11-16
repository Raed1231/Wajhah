export const USER_TYPES = ['citizen', 'resident', 'visitor', 'pilgrim']
const SESSION_KEY = 'wajhah-session'

const errorKeys = {
  INVALID_DETAILS: 'accountInvalid', ACCOUNT_EXISTS: 'accountExists', INVALID_CODE: 'codeInvalid',
  CODE_EXPIRED: 'codeExpired', TOO_MANY_ATTEMPTS: 'codeAttempts', CODE_COOLDOWN: 'codeCooldown',
  ALREADY_VERIFIED: 'alreadyVerified', INVALID_CREDENTIALS: 'invalidCredentials', ACCOUNT_NOT_VERIFIED: 'notVerified',
  NOT_SIGNED_IN: 'signedOut', DATABASE_UNAVAILABLE: 'accountUnavailable', INVALID_REQUEST: 'invalidRequest',
  REQUEST_TOO_LARGE: 'invalidRequest',
}
const fieldKeys = {
  INVALID_NAME: 'nameInvalid', INVALID_EMAIL: 'emailInvalid', INVALID_PHONE: 'phoneInvalid', WEAK_PASSWORD: 'passwordWeak',
  INVALID_USER_TYPE: 'userTypeInvalid', EMAIL_TAKEN: 'emailTaken', PHONE_TAKEN: 'phoneTaken', WRONG_PASSWORD: 'passwordWrong',
}

export class AccountError extends Error {
  constructor(code, fields = {}) {
    super(code)
    this.name = 'AccountError'
    this.code = code
    this.fields = fields
  }
}

export function normalizePhone(phone) {
  const value = phone.replace(/[\s\-()]/g, '')
  if (/^05\d{8}$/.test(value)) return `+966${value.slice(1)}`
  if (/^\+[1-9]\d{7,14}$/.test(value)) return value
  return null
}

export function nameError(name) {
  const value = name.split(/\s+/).filter(Boolean).join(' ')
  if (!value) return 'fieldRequired'
  return value.length >= 2 && value.length <= 100 && /^\p{L}+(?:[ '-]\p{L}+)*$/u.test(value) ? '' : 'nameInvalid'
}

export function emailError(email) {
  const value = email.trim().toLowerCase()
  if (!value) return 'fieldRequired'
  return value.length <= 254 && /^[^@\s]{1,64}@[^@\s.]+(?:\.[^@\s.]+)*\.[a-z]{2,}$/.test(value) ? '' : 'emailInvalid'
}

export function phoneError(phone) {
  if (!phone.trim()) return 'fieldRequired'
  return normalizePhone(phone) ? '' : 'phoneInvalid'
}

export function passwordError(password) {
  if (!password) return 'fieldRequired'
  return password.length >= 8 && password.length <= 128 && /\p{L}/u.test(password) && /\d/.test(password) ? '' : 'passwordWeak'
}

export function userTypeError(userType) {
  if (!userType) return 'fieldRequired'
  return USER_TYPES.includes(userType) ? '' : 'userTypeInvalid'
}

function onlyErrors(errors) {
  return Object.fromEntries(Object.entries(errors).filter(([, value]) => value))
}

export function registrationErrors(form) {
  return onlyErrors({
    name: nameError(form.name), email: emailError(form.email), phone: phoneError(form.phone),
    password: passwordError(form.password), user_type: userTypeError(form.user_type),
    confirm: form.confirm === form.password ? '' : 'passwordMismatch',
  })
}

export function profileErrors(form) {
  return onlyErrors({ name: nameError(form.name), phone: phoneError(form.phone), user_type: userTypeError(form.user_type) })
}

export function loadSession() {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_KEY))
    return typeof value?.token === 'string' ? value : null
  } catch {
    return null
  }
}

export function saveSession(session) {
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session))
    else localStorage.removeItem(SESSION_KEY)
  } catch {
    return
  }
}

async function request(path, { method = 'POST', body, token } = {}, fetcher = fetch) {
  const headers = { Accept: 'application/json' }
  if (body) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  let response
  try {
    response = await fetcher(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  } catch {
    throw new AccountError('network')
  }
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new AccountError(response.ok ? 'invalidResponse' : 'accountUnavailable')
  }
  if (!response.ok) {
    const detail = payload?.detail
    const fields = Object.fromEntries(Object.entries(detail?.fields || {}).map(([field, code]) => [field, fieldKeys[code] || 'invalidRequest']))
    throw new AccountError(errorKeys[detail?.code] || (response.status >= 500 ? 'accountUnavailable' : 'requestFailed'), fields)
  }
  return payload
}

export function register(form, language, fetcher) {
  const { name, email, phone, password, user_type } = form
  return request('/auth/register', { body: { name, email: email.trim(), phone, password, user_type, language } }, fetcher)
}

export function verifyAccount(email, code, fetcher) {
  return request('/auth/verify', { body: { email: email.trim(), code: code.trim() } }, fetcher)
}

export function resendCode(email, language, fetcher) {
  return request('/auth/resend-code', { body: { email: email.trim(), language } }, fetcher)
}

export function signIn(email, password, fetcher) {
  return request('/auth/login', { body: { email: email.trim(), password } }, fetcher)
}

export function signOut(token, fetcher) {
  return request('/auth/logout', { token }, fetcher)
}

export function getProfile(token, fetcher) {
  return request('/profile', { method: 'GET', token }, fetcher)
}

export function updateProfile(token, form, fetcher) {
  const { name, phone, user_type } = form
  return request('/profile', { method: 'PATCH', token, body: { name, phone, user_type } }, fetcher)
}

export function deleteAccount(token, password, fetcher) {
  return request('/profile', { method: 'DELETE', token, body: { password } }, fetcher)
}
