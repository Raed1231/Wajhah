// Drafts retain their service and fact revision until explicitly regenerated.
export function draftContextChanged(previousRoute, nextRoute, intent) {
  return previousRoute?.status !== nextRoute?.status
    || previousRoute?.service_id !== nextRoute?.service_id
    || ['FACTS_UPDATE', 'REASSESS'].includes(intent)
}

export function draftPresentation(record, { serviceId, revision }) {
  if (!record) return { text: '', outdated: false, edited: false, showEditor: false }
  const outdated = record.serviceId !== serviceId || record.revision !== revision
  const edited = record.text !== record.generatedText
  return { text: outdated && !edited ? '' : record.text, outdated, edited, showEditor: !outdated || edited }
}

export const MAX_REVIEWED_FACTS = 32000

export function emptyFactsReview() {
  return { data: null, binding: null, text: '', confirmed: false, requiresRefresh: false }
}

export function factsReviewBinding({ serviceId, revision, language, languageRevision = 0 }) {
  return JSON.stringify([serviceId, revision, language, languageRevision])
}

export function factsReviewStatus(state, binding) {
  const current = Boolean(state.data && state.binding === binding && !state.requiresRefresh)
  const validText = Boolean(state.text.trim()) && state.text.length <= MAX_REVIEWED_FACTS
  return { current, confirmed: current && state.confirmed, canSubmit: current && validText && state.confirmed }
}

export function factsReviewReducer(state, action) {
  switch (action.type) {
    case 'PREPARED':
      // Never seed final facts from the original/updates/extracted references.
      return { ...state, data: action.data, binding: action.binding, confirmed: false, requiresRefresh: false }
    case 'EDIT':
      return { ...state, text: action.text, confirmed: false }
    case 'CONFIRM':
      return { ...state, confirmed: action.confirmed === true && factsReviewStatus(state, action.binding).current && Boolean(state.text.trim()) && state.text.length <= MAX_REVIEWED_FACTS }
    case 'EXPIRED':
      return { ...state, confirmed: false, requiresRefresh: true }
    case 'COMPLETED':
      return { ...state, data: null, binding: null, confirmed: false, requiresRefresh: false }
    default:
      return state
  }
}
