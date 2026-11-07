export const MAX_FILE_SIZE = 5 * 1024 * 1024
export const MAX_MESSAGE_LENGTH = 6000
export const REQUEST_TIMEOUT_MS = 70000
export const ACCEPTED_FILES = '.jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf'

const fileTypes = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' }
const statuses = new Set(['MATCHED', 'NEEDS_CLARIFICATION', 'NOT_SUPPORTED'])
const retryableErrors = new Set(['network', 'serverUnavailable', 'requestFailed', 'aiUnavailable', 'aiOverloaded', 'aiTimeout', 'aiConnection', 'rateLimit', 'invalidResponse', 'invalidRoute'])
const backendErrorCodes = {
  EMPTY_COMPLAINT: 'required', INVALID_REQUEST: 'invalidRequest', REQUEST_TOO_LARGE: 'invalidRequest', AI_NOT_CONFIGURED: 'aiUnavailable',
  ATTACHMENT_TOO_LARGE: 'fileLarge', UNSUPPORTED_FILE_TYPE: 'fileType', EMPTY_FILE: 'fileEmpty',
  INVALID_FILE_CONTENT: 'fileContent', INVALID_PDF: 'invalidPdf', ENCRYPTED_PDF: 'encryptedPdf',
  PDF_PAGE_LIMIT: 'pdfPageLimit', INVALID_IMAGE: 'invalidImage', MESSAGE_TOO_LONG: 'tooLong',
  INVALID_HISTORY: 'invalidHistory', AI_OVERLOADED: 'aiOverloaded', AI_RATE_LIMITED: 'rateLimit',
  AI_TIMEOUT: 'aiTimeout', AI_CONNECTION_ERROR: 'aiConnection', AI_UPSTREAM_ERROR: 'aiUnavailable',
  AI_INVALID_RESPONSE: 'invalidResponse', AI_INVALID_ROUTE: 'invalidRoute',
  CONVERSATION_LIMIT: 'conversationLimit', CONVERSATION_EXPIRED: 'conversationExpired',
  SERVICE_NOT_FOUND: 'guidanceNotFound', SERVICE_INFORMATION_UNAVAILABLE: 'guidanceUnavailable',
  DRAFT_REQUIRES_MATCH: 'draftRequiresMatch', DRAFT_CONTEXT_LIMIT: 'draftContextLimit',
  DRAFT_REVIEW_REQUIRED: 'draftReviewRequired',
}

function fileExtension(file) {
  return file.name.lastIndexOf('.') > 0 ? file.name.split('.').pop().toLowerCase() : ''
}

export class ApiError extends Error {
  constructor(code, { retryable = retryableErrors.has(code), requestId = '', status, backendCode } = {}) {
    super(code)
    this.name = 'ApiError'
    this.code = code
    this.retryable = retryable
    this.requestId = typeof requestId === 'string' && /^[a-zA-Z0-9._-]{1,100}$/.test(requestId) ? requestId : ''
    this.status = status
    this.backendCode = backendCode
  }
}

export function messageError(message) {
  if (!message.trim()) return 'required'
  if (message.length > MAX_MESSAGE_LENGTH) return 'tooLong'
  return ''
}

export function fileError(file) {
  if (!file) return ''
  const extension = fileExtension(file)
  if (!fileTypes[extension] || (file.type && file.type !== fileTypes[extension])) return 'fileType'
  if (file.size === 0) return 'fileEmpty'
  if (file.size > MAX_FILE_SIZE) return 'fileLarge'
  return ''
}

async function validateFileContent(file) {
  const error = fileError(file)
  if (error) throw new ApiError(error)
  const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer())
  const extension = fileExtension(file)
  const signature = extension === 'pdf' ? [37, 80, 68, 70, 45]
    : extension === 'png' ? [137, 80, 78, 71, 13, 10, 26, 10] : [255, 216, 255]
  if (!signature.every((byte, index) => bytes[index] === byte)) throw new ApiError('fileContent')
}

// Preserve the original complaint and attachment facts when trimming legacy history.
export function requestHistory(history) {
  return history.length <= 10 ? history : [history[0], ...history.slice(-9)]
}

function isHistory(history) {
  return Array.isArray(history) && history.length >= 2 && history.every((entry) => (
    entry && ['user', 'assistant'].includes(entry.role) && typeof entry.text === 'string' && entry.text.trim()
  )) && history[0].role === 'user' && history.at(-1).role === 'assistant'
}

export function normalizeResult(payload, attachment = false) {
  const routing = attachment ? payload?.routing : payload
  if (!routing || !statuses.has(routing.status)) throw new ApiError('invalidResponse')
  for (const key of ['reason', 'authority', 'service_name', 'official_url', 'link_verification']) {
    if (routing[key] != null && typeof routing[key] !== 'string') throw new ApiError('invalidResponse')
  }
  if (routing.status === 'MATCHED' && (typeof routing.service_name !== 'string' || !routing.service_name.trim())) {
    throw new ApiError('invalidResponse')
  }
  if (routing.status === 'NEEDS_CLARIFICATION') {
    if (typeof routing.question !== 'string' || !routing.question.trim()) throw new ApiError('invalidResponse')
    // Never reconstruct multipart history from the visible complaint: that loses
    // the attachment facts which only exist in routing.history[0].text.
    if (!isHistory(routing.history)) throw new ApiError(attachment ? 'attachmentHistory' : 'invalidResponse')
  }
  return {
    ...routing,
    history: routing.status === 'NEEDS_CLARIFICATION' ? routing.history : [],
    attachmentAnalysis: attachment ? payload.attachment_analysis ?? null : null,
    conversation: normalizeConversation(payload?.conversation),
  }
}

export function normalizeConversation(value) {
  if (value == null) return null // Older routing responses remain supported.
  if (typeof value !== 'object' || typeof value.token !== 'string' || !/^[A-Za-z0-9_.-]{1,350000}$/.test(value.token)
    || !Number.isSafeInteger(value.turn_count) || value.turn_count < 0) throw new ApiError('invalidResponse')
  return { token: value.token, turn_count: value.turn_count }
}

const followupIntents = new Set(['ROUTE_QUESTION', 'FACTS_UPDATE', 'REASSESS', 'PROCEDURE', 'OUT_OF_SCOPE'])

export function normalizeFollowup(payload) {
  if (!payload || typeof payload.reply !== 'string' || !payload.reply.trim() || payload.reply.length > 6000
    || !followupIntents.has(payload.intent) || typeof payload.route_changed !== 'boolean') throw new ApiError('invalidResponse')
  const conversation = normalizeConversation(payload.conversation)
  if (!conversation) throw new ApiError('invalidResponse')
  const route = normalizeResult(payload.route)
  if (route.status === 'MATCHED' && (typeof route.service_id !== 'string' || !route.service_id.trim()
    || !safeOfficialUrl(route.official_url))) throw new ApiError('invalidResponse')
  return { reply: payload.reply.trim(), intent: payload.intent, route, route_changed: payload.route_changed, conversation }
}

export function safeOfficialUrl(value) {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
  } catch {
    return null
  }
}

function responseError(status, detail) {
  if (detail && typeof detail === 'object' && !Array.isArray(detail) && Object.hasOwn(backendErrorCodes, detail.code)) {
    return new ApiError(backendErrorCodes[detail.code], {
      retryable: typeof detail.retryable === 'boolean' ? detail.retryable : undefined,
      requestId: detail.request_id,
      status,
      backendCode: detail.code,
    })
  }
  if (status === 413) return new ApiError('fileLarge', { status })
  const known = {
    'Unsupported file type': 'fileType',
    'Empty file': 'fileEmpty',
    'File content does not match its type': 'fileContent',
    'Invalid file content': 'fileContent',
    'Complaint cannot be empty': 'required',
  }
  if (typeof detail === 'string' && Object.hasOwn(known, detail)) return new ApiError(known[detail], { status })
  if (status === 422) return new ApiError('invalidRequest', { status })
  if (status === 502 && typeof detail === 'string' && /Gemini|analysis|AI|service ID|question/i.test(detail)) return new ApiError('aiUnavailable', { status })
  if (status === 429) return new ApiError('rateLimit', { status })
  if (status === 503) return new ApiError('aiOverloaded', { status })
  if (status === 504) return new ApiError('aiTimeout', { status })
  return new ApiError(status >= 500 ? 'serverUnavailable' : 'requestFailed', { status })
}

export async function sendComplaint({ message, history = [], file = null, signal }, fetcher = fetch) {
  const error = messageError(message)
  if (error) throw new ApiError(error)
  if (file && history.length) throw new ApiError('followupAttachment')
  if (file) await validateFileContent(file)
  signal?.throwIfAborted()

  let body
  const headers = { Accept: 'application/json' }
  if (file) {
    body = new FormData()
    body.append('complaint', message.trim())
    body.append('file', file)
    // The browser supplies the multipart boundary.
  } else {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify({ message: message.trim(), history: requestHistory(history) })
  }
  let response
  try {
    response = await fetcher(`/api/${file ? 'route-with-attachment' : 'route'}`, { method: 'POST', headers, body, signal })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new ApiError('network')
  }
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new ApiError(response.ok ? 'invalidResponse' : 'serverUnavailable')
  }
  if (!response.ok) throw responseError(response.status, payload?.detail)
  return normalizeResult(payload, Boolean(file))
}

export async function checkHealth(signal) {
  const response = await fetch('/api/health', { signal, headers: { Accept: 'application/json' } })
  const body = await response.json()
  if (!response.ok || body.status !== 'ok' || body.project !== 'Wajhah') throw new ApiError('serverUnavailable')
}

export async function sendFollowup({ message, conversationToken, language = 'ar', signal }, fetcher = fetch) {
  const error = messageError(message)
  if (error) throw new ApiError(error)
  if (typeof conversationToken !== 'string' || !/^[A-Za-z0-9_.-]{1,350000}$/.test(conversationToken)
    || !['ar', 'en'].includes(language)) throw new ApiError('invalidRequest', { retryable: false })
  signal?.throwIfAborted()
  let response
  try {
    response = await fetcher('/api/follow-up', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ message: message.trim(), conversation_token: conversationToken, language }),
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new ApiError('network')
  }
  let payload
  try { payload = await response.json() } catch { throw new ApiError(response.ok ? 'invalidResponse' : 'serverUnavailable') }
  if (!response.ok) throw responseError(response.status, payload?.detail)
  return normalizeFollowup(payload)
}

const verificationStatuses = new Set(['Verified', 'Unverified', 'Conflicting', 'Missing'])
const requirementStatuses = new Set(['MANDATORY', 'OPTIONAL', 'CONDITIONAL', 'UNKNOWN', 'NOT_APPLICABLE'])
const MAX_GUIDANCE_ITEMS_PER_GROUP = 150
const MAX_GUIDANCE_SOURCES = 300
export const GUIDANCE_GROUPS = ['prerequisites', 'steps', 'information', 'documents', 'eligibility', 'channels', 'drafting_guidance']

function boundedText(value, maximum = 12000, optional = false) {
  if (optional && value == null) return ''
  if (typeof value !== 'string' || value.length > maximum || (!optional && !value.trim())) throw new ApiError('invalidResponse')
  return value
}

function stringList(value, maximum = 100) {
  if (!Array.isArray(value) || value.length > maximum) throw new ApiError('invalidResponse')
  return value.map((item) => boundedText(item))
}

// Reject local hostnames and IP literals. A safe URL does not establish
// source verification.
export function safeSourceUrl(value) {
  const candidate = safeOfficialUrl(value)
  if (!candidate) return null
  const { hostname, port } = new URL(candidate)
  if ((port && port !== '443') || !hostname.includes('.') || hostname.includes(':') || /^\d+(?:\.\d+){3}$/.test(hostname)
    || /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(hostname)) return null
  return candidate
}

function guidanceItem(item) {
  if (!item || !verificationStatuses.has(item.verification_status) || !requirementStatuses.has(item.requirement_status)
    || (item.order != null && (!Number.isSafeInteger(item.order) || item.order < 0))) throw new ApiError('invalidResponse')
  return {
    id: boundedText(item.id, 300), title: boundedText(item.title),
    description: boundedText(item.description, 12000, true),
    verification_status: item.verification_status, requirement_status: item.requirement_status,
    conditions: boundedText(item.conditions, 12000, true), scope: boundedText(item.scope, 12000, true),
    order: item.order ?? null, source_ids: stringList(item.source_ids), url: safeSourceUrl(item.url),
    channel_ids: item.channel_ids == null ? [] : stringList(item.channel_ids, MAX_GUIDANCE_ITEMS_PER_GROUP),
  }
}

export function normalizeGuidance(payload, expectedServiceId, expectedLanguage) {
  if (!payload || payload.service_id !== expectedServiceId || payload.language !== expectedLanguage
    || !Array.isArray(payload.sources) || payload.sources.length > MAX_GUIDANCE_SOURCES) throw new ApiError('invalidResponse')
  const sources = payload.sources.map((source) => {
    if (!source || !verificationStatuses.has(source.verification_status)) throw new ApiError('invalidResponse')
    return {
      id: boundedText(source.id, 300), title: boundedText(source.title), url: safeSourceUrl(source.url),
      accessed_at: boundedText(source.accessed_at, 100, true), verification_status: source.verification_status,
      evidence_basis: boundedText(source.evidence_basis, 12000, true),
    }
  })
  const sourceById = new Map(sources.map((source) => [source.id, source]))
  if (sourceById.size !== sources.length) throw new ApiError('invalidResponse')
  const result = {
    service_id: expectedServiceId, language: expectedLanguage,
    service_name: boundedText(payload.service_name), authority: boundedText(payload.authority),
    reviewed_at: boundedText(payload.reviewed_at, 100, true), sources,
    service_scope: boundedText(payload.service_scope, 12000, true),
    service_scope_language: ['ar', 'en'].includes(payload.service_scope_language) ? payload.service_scope_language : undefined,
    gaps: [], unverified_items: {},
  }
  if (!Array.isArray(payload.gaps) || payload.gaps.length > 100) throw new ApiError('invalidResponse')
  result.gaps = payload.gaps.map((gap) => {
    if (!gap || typeof gap !== 'object') throw new ApiError('invalidResponse')
    return { id: boundedText(gap.id, 300), title: boundedText(gap.title), reason: boundedText(gap.reason) }
  })
  const support = payload.ai_submission_support
  if (!support || !verificationStatuses.has(support.verification_status)) throw new ApiError('invalidResponse')
  result.ai_submission_support = { status: boundedText(support.status, 100), verification_status: support.verification_status, source_ids: stringList(support.source_ids) }
  if (payload.unverified_items != null && (typeof payload.unverified_items !== 'object' || Array.isArray(payload.unverified_items))) throw new ApiError('invalidResponse')
  for (const group of GUIDANCE_GROUPS) {
    if (!Array.isArray(payload[group]) || payload[group].length > MAX_GUIDANCE_ITEMS_PER_GROUP) throw new ApiError('invalidResponse')
    const items = payload[group].map(guidanceItem)
    const excluded = payload.unverified_items?.[group] ?? []
    if (!Array.isArray(excluded) || items.length + excluded.length > MAX_GUIDANCE_ITEMS_PER_GROUP) throw new ApiError('invalidResponse')
    const isOfficial = (item) => item.verification_status === 'Verified' && item.source_ids.length > 0
      && item.source_ids.every((id) => sourceById.get(id)?.verification_status === 'Verified' && sourceById.get(id)?.url)
    result[group] = items.filter(isOfficial).sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER))
    result.unverified_items[group] = [...items.filter((item) => !isOfficial(item)).map((item) => item.verification_status === 'Verified' ? { ...item, verification_status: 'Unverified' } : item), ...excluded.map(guidanceItem)]
  }
  return result
}

export function selectChannelGuidance(guidance, channelId) {
  const channel = guidance.channels.find((item) => item.id === channelId) ?? guidance.channels[0] ?? null
  const applies = (item) => channel && item.channel_ids.includes(channel.id)
  const unassigned = (item) => item.channel_ids.length === 0
  return {
    channel,
    prerequisites: guidance.prerequisites.filter(applies),
    steps: guidance.steps.filter(applies),
    unassignedPrerequisites: guidance.prerequisites.filter(unassigned),
    unassignedSteps: guidance.steps.filter(unassigned),
  }
}

async function readServiceResponse(response) {
  let payload
  try { payload = await response.json() } catch { throw new ApiError(response.ok ? 'invalidResponse' : 'serverUnavailable') }
  if (!response.ok) throw responseError(response.status, payload?.detail)
  return payload
}

export async function fetchServiceGuidance({ serviceId, language, signal }, fetcher = fetch) {
  if (typeof serviceId !== 'string' || !/^[A-Za-z0-9_.-]{1,300}$/.test(serviceId) || !['ar', 'en'].includes(language)) throw new ApiError('invalidRequest', { retryable: false })
  signal?.throwIfAborted()
  let response
  try {
    response = await fetcher(`/api/services/${encodeURIComponent(serviceId)}/guidance?language=${language}`, { signal, headers: { Accept: 'application/json' } })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new ApiError('network')
  }
  return normalizeGuidance(await readServiceResponse(response), serviceId, language)
}

export function normalizeComplaintDraft(payload, { serviceId, language, turnCount }) {
  if (!payload || payload.service_id !== serviceId || payload.language !== language
    || payload.conversation_turn_count !== turnCount) throw new ApiError('invalidResponse')
  if (payload.review_required === true) {
    if (typeof payload.context_id !== 'string' || !/^[a-f0-9]{64}$/.test(payload.context_id)
      || payload.draft_text != null || !Array.isArray(payload.updates) || payload.updates.length > 12) throw new ApiError('invalidResponse')
    return {
      review_required: true, context_id: payload.context_id, language, service_id: serviceId,
      original_text: boundedText(payload.original_text, 32000),
      updates: payload.updates.map((update) => {
        if (!update || typeof update !== 'object') throw new ApiError('invalidResponse')
        return { text: boundedText(update.text, 16000), question: boundedText(update.question, 16000, true) }
      }),
      attachment_excerpts: stringList(payload.attachment_excerpts), conversation_turn_count: turnCount,
    }
  }
  if (!Number.isSafeInteger(payload.source_fact_count) || payload.source_fact_count < 1) throw new ApiError('invalidResponse')
  return {
    draft_text: boundedText(payload.draft_text, 60000), language, service_id: serviceId,
    source_fact_count: payload.source_fact_count, omitted_fields: stringList(payload.omitted_fields),
    warnings: stringList(payload.warnings), conversation_turn_count: turnCount,
  }
}

export async function generateComplaintDraft({ conversationToken, serviceId, language, turnCount, signal, reviewedFacts, reviewContextId, factsConfirmed }, fetcher = fetch) {
  if (typeof conversationToken !== 'string' || !/^[A-Za-z0-9_.-]{1,350000}$/.test(conversationToken)
    || (serviceId !== null && (typeof serviceId !== 'string' || !serviceId)) || !['ar', 'en'].includes(language)
    || !Number.isSafeInteger(turnCount) || turnCount < 0) throw new ApiError('invalidRequest', { retryable: false })
  const hasReview = reviewedFacts !== undefined || reviewContextId !== undefined || factsConfirmed !== undefined
  if (hasReview && (typeof reviewedFacts !== 'string' || !reviewedFacts.trim() || reviewedFacts.length > 32000
    || typeof reviewContextId !== 'string' || !/^[a-f0-9]{64}$/.test(reviewContextId) || factsConfirmed !== true)) throw new ApiError('draftReviewInvalid', { retryable: false })
  const body = { conversation_token: conversationToken, language }
  if (hasReview) Object.assign(body, { reviewed_facts: reviewedFacts.trim(), review_context_id: reviewContextId, facts_confirmed: true })
  signal?.throwIfAborted()
  let response
  try {
    response = await fetcher('/api/complaint-draft', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify(body),
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new ApiError('network')
  }
  return normalizeComplaintDraft(await readServiceResponse(response), { serviceId, language, turnCount })
}

export function guidanceSubmissionSupport(guidance) {
  const support = guidance.ai_submission_support
  return {
    status: support.status, verification_status: support.verification_status,
    sources: support.source_ids.map((id) => guidance.sources.find((source) => source.id === id))
      .filter((source) => source && safeSourceUrl(source.url)),
  }
}
