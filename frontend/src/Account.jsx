import { useState } from 'react'
import { USER_TYPES, deleteAccount, emailError, profileErrors, register, registrationErrors, resendCode, signIn, signOut, updateProfile, verifyAccount } from './account-api.js'

const emptyForm = { name: '', email: '', phone: '', password: '', confirm: '', user_type: '' }

function profileForm(user) {
  return { name: user?.name || '', phone: user?.phone || '', user_type: user?.user_type || '' }
}

function Field({ id, label, hint, error, t, children }) {
  return <div className="account-field">
    <label className="field-label" htmlFor={id}>{label}</label>
    {children}
    {hint && !error && <p className="account-hint" id={`${id}-hint`}>{hint}</p>}
    {error && <p className="field-error" id={`${id}-error`}>{t[error] || t.invalidRequest}</p>}
  </div>
}

function TextInput({ id, label, hint, value, onChange, error, t, type = 'text', autoComplete, dir, disabled, inputMode, maxLength }) {
  const described = error ? `${id}-error` : hint ? `${id}-hint` : undefined
  return <Field id={id} label={label} hint={hint} error={error} t={t}>
    <input id={id} type={type} value={value} onChange={(event) => onChange(event.target.value)} autoComplete={autoComplete} dir={dir} disabled={disabled}
      inputMode={inputMode} maxLength={maxLength} aria-invalid={Boolean(error)} aria-describedby={described} />
  </Field>
}

function UserTypeSelect({ id, value, onChange, error, t, disabled }) {
  return <Field id={id} label={t.userType} error={error} t={t}>
    <select id={id} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}>
      <option value="">{t.chooseUserType}</option>
      {USER_TYPES.map((type) => <option key={type} value={type}>{t[`userType_${type}`]}</option>)}
    </select>
  </Field>
}

export default function Account({ language, t, session, onSession, onClose }) {
  const [mode, setMode] = useState(session ? 'profile' : 'login')
  const [form, setForm] = useState(emptyForm)
  const [profile, setProfile] = useState(() => profileForm(session?.user))
  const [code, setCode] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [deletePassword, setDeletePassword] = useState('')
  const [errors, setErrors] = useState({})
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState(false)
  const user = session?.user

  function go(next, message = '') {
    setMode(next); setErrors({}); setError(''); setNotice(message); setCode(''); setDeleting(false); setDeletePassword('')
    setForm((current) => ({ ...current, password: '', confirm: '' }))
  }

  function edit(setter, field) {
    return (value) => {
      setter((current) => ({ ...current, [field]: value }))
      setErrors((current) => ({ ...current, [field]: '' }))
      setError('')
    }
  }

  async function run(action) {
    if (pending) return
    setPending(true); setError(''); setNotice('')
    try {
      await action()
    } catch (failure) {
      if (failure.code === 'signedOut' && session) {
        onSession(null)
        go('login', 'signedOut')
        return
      }
      setError(failure.code || 'requestFailed')
      setErrors(failure.fields || {})
    } finally {
      setPending(false)
    }
  }

  function submitRegister(event) {
    event.preventDefault()
    const found = registrationErrors(form)
    setErrors(found)
    if (Object.keys(found).length) { setError('accountInvalid'); return }
    run(async () => {
      const result = await register(form, language)
      go('verify', result.code_sent ? 'codeSent' : 'codeNotSent')
    })
  }

  function submitVerify(event) {
    event.preventDefault()
    const found = { email: emailError(form.email), code: /^\d{6}$/.test(code.trim()) ? '' : 'codeFormat' }
    setErrors(found)
    if (found.email || found.code) return
    run(async () => {
      try {
        await verifyAccount(form.email, code)
        go('login', 'verifiedNotice')
      } catch (failure) {
        if (failure.code === 'alreadyVerified') go('login', 'alreadyVerified')
        else throw failure
      }
    })
  }

  function resend() {
    const found = emailError(form.email)
    setErrors({ email: found })
    if (found) return
    run(async () => {
      const result = await resendCode(form.email, language)
      setNotice(result.code_sent ? 'codeSent' : 'codeNotSent')
    })
  }

  function submitSignIn(event) {
    event.preventDefault()
    const found = { email: emailError(form.email), password: form.password ? '' : 'fieldRequired' }
    setErrors(found)
    if (found.email || found.password) return
    run(async () => {
      try {
        const result = await signIn(form.email, form.password)
        onSession({ token: result.token, user: result.user })
        setProfile(profileForm(result.user))
        go('profile')
      } catch (failure) {
        if (failure.code === 'notVerified') go('verify', 'notVerified')
        else throw failure
      }
    })
  }

  function submitProfile(event) {
    event.preventDefault()
    const found = profileErrors(profile)
    setErrors(found)
    if (Object.keys(found).length) { setError('accountInvalid'); return }
    run(async () => {
      const updated = await updateProfile(session.token, profile)
      onSession({ ...session, user: updated })
      setProfile(profileForm(updated))
      setNotice('profileSaved')
    })
  }

  function submitSignOut() {
    run(async () => {
      try {
        await signOut(session.token)
      } finally {
        onSession(null)
        setForm(emptyForm)
        go('login')
      }
    })
  }

  function submitDelete(event) {
    event.preventDefault()
    const found = deletePassword ? '' : 'fieldRequired'
    setErrors({ delete_password: found })
    if (found) return
    run(async () => {
      try {
        await deleteAccount(session.token, deletePassword)
      } catch (failure) {
        throw failure.fields?.password ? Object.assign(failure, { fields: { delete_password: failure.fields.password } }) : failure
      }
      onSession(null)
      setForm(emptyForm)
      go('login', 'accountDeleted')
    })
  }

  const title = { login: t.signIn, register: t.registerTitle, verify: t.verifyTitle, profile: t.profileTitle }[mode]
  const intro = { login: t.signInIntro, register: t.registerIntro, verify: t.verifyIntro, profile: '' }[mode]

  return <section className="form-card account-card" aria-labelledby="account-heading" aria-busy={pending}>
    <div className="form-heading account-heading">
      <div><h2 id="account-heading">{title}</h2>{intro && <p>{intro}</p>}</div>
      <button className="text-button" type="button" onClick={onClose} disabled={pending}>{t.backToComplaint}</button>
    </div>
    {notice && <p className="notice" role="status">{t[notice]}</p>}
    {error && <div className="error-banner" role="alert"><p>{t[error] || t.requestFailed}</p></div>}

    {mode === 'login' && <form onSubmit={submitSignIn} noValidate>
      <TextInput id="login-email" label={t.email} value={form.email} onChange={edit(setForm, 'email')} error={errors.email} t={t} type="email" autoComplete="email" dir="ltr" disabled={pending} />
      <TextInput id="login-password" label={t.password} value={form.password} onChange={edit(setForm, 'password')} error={errors.password} t={t} type="password" autoComplete="current-password" dir="ltr" disabled={pending} />
      <div className="account-actions">
        <button className="button primary" type="submit" disabled={pending}>{pending ? <><span className="spinner" />{t.accountPending}</> : t.signIn}</button>
        <button className="text-button" type="button" onClick={() => go('register')} disabled={pending}>{t.noAccount}</button>
        <button className="text-button" type="button" onClick={() => go('verify')} disabled={pending}>{t.haveCode}</button>
      </div>
    </form>}

    {mode === 'register' && <form onSubmit={submitRegister} noValidate>
      <TextInput id="register-name" label={t.fullName} value={form.name} onChange={edit(setForm, 'name')} error={errors.name} t={t} autoComplete="name" dir="auto" disabled={pending} maxLength={100} />
      <TextInput id="register-email" label={t.email} value={form.email} onChange={edit(setForm, 'email')} error={errors.email} t={t} type="email" autoComplete="email" dir="ltr" disabled={pending} maxLength={254} />
      <TextInput id="register-phone" label={t.phone} hint={t.phoneHint} value={form.phone} onChange={edit(setForm, 'phone')} error={errors.phone} t={t} type="tel" autoComplete="tel" dir="ltr" disabled={pending} maxLength={20} />
      <UserTypeSelect id="register-type" value={form.user_type} onChange={edit(setForm, 'user_type')} error={errors.user_type} t={t} disabled={pending} />
      <TextInput id="register-password" label={t.password} hint={t.passwordHint} value={form.password} onChange={edit(setForm, 'password')} error={errors.password} t={t} type="password" autoComplete="new-password" dir="ltr" disabled={pending} maxLength={128} />
      <TextInput id="register-confirm" label={t.confirmPassword} value={form.confirm} onChange={edit(setForm, 'confirm')} error={errors.confirm} t={t} type="password" autoComplete="new-password" dir="ltr" disabled={pending} maxLength={128} />
      <div className="account-actions">
        <button className="button primary" type="submit" disabled={pending}>{pending ? <><span className="spinner" />{t.accountPending}</> : t.createAccount}</button>
        <button className="text-button" type="button" onClick={() => go('login')} disabled={pending}>{t.haveAccount}</button>
      </div>
    </form>}

    {mode === 'verify' && <form onSubmit={submitVerify} noValidate>
      <TextInput id="verify-email" label={t.email} value={form.email} onChange={edit(setForm, 'email')} error={errors.email} t={t} type="email" autoComplete="email" dir="ltr" disabled={pending} />
      <TextInput id="verify-code" label={t.verificationCode} value={code} onChange={(value) => { setCode(value.replace(/\D/g, '')); setErrors((current) => ({ ...current, code: '' })) }} error={errors.code} t={t} autoComplete="one-time-code" dir="ltr" inputMode="numeric" maxLength={6} disabled={pending} />
      <div className="account-actions">
        <button className="button primary" type="submit" disabled={pending}>{pending ? <><span className="spinner" />{t.accountPending}</> : t.verify}</button>
        <button className="text-button" type="button" onClick={resend} disabled={pending}>{t.resendCode}</button>
        <button className="text-button" type="button" onClick={() => go('login')} disabled={pending}>{t.haveAccount}</button>
      </div>
    </form>}

    {mode === 'profile' && user && <>
      <form onSubmit={submitProfile} noValidate>
        <TextInput id="profile-email" label={t.email} value={user.email} onChange={() => {}} t={t} dir="ltr" disabled />
        <TextInput id="profile-name" label={t.fullName} value={profile.name} onChange={edit(setProfile, 'name')} error={errors.name} t={t} autoComplete="name" dir="auto" disabled={pending} maxLength={100} />
        <TextInput id="profile-phone" label={t.phone} hint={t.phoneHint} value={profile.phone} onChange={edit(setProfile, 'phone')} error={errors.phone} t={t} type="tel" autoComplete="tel" dir="ltr" disabled={pending} maxLength={20} />
        <UserTypeSelect id="profile-type" value={profile.user_type} onChange={edit(setProfile, 'user_type')} error={errors.user_type} t={t} disabled={pending} />
        <div className="account-actions">
          <button className="button primary" type="submit" disabled={pending}>{pending ? <><span className="spinner" />{t.accountPending}</> : t.saveProfile}</button>
          <button className="button secondary" type="button" onClick={submitSignOut} disabled={pending}>{t.signOut}</button>
        </div>
      </form>
      <div className="account-danger">
        {!deleting ? <button className="text-button danger-button" type="button" onClick={() => { setDeleting(true); setNotice(''); setError('') }} disabled={pending}>{t.deleteAccount}</button>
          : <form onSubmit={submitDelete} noValidate>
            <p className="account-warning">{t.deleteWarning}</p>
            <TextInput id="delete-password" label={t.password} value={deletePassword} onChange={(value) => { setDeletePassword(value); setErrors((current) => ({ ...current, delete_password: '' })) }} error={errors.delete_password} t={t} type="password" autoComplete="current-password" dir="ltr" disabled={pending} />
            <div className="account-actions">
              <button className="button danger" type="submit" disabled={pending}>{pending ? <><span className="spinner" />{t.accountPending}</> : t.confirmDelete}</button>
              <button className="text-button" type="button" onClick={() => { setDeleting(false); setDeletePassword(''); setErrors({}) }} disabled={pending}>{t.cancel}</button>
            </div>
          </form>}
      </div>
    </>}
  </section>
}
