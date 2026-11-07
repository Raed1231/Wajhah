import { useEffect, useReducer, useRef, useState } from 'react'
import { draftPresentation, emptyFactsReview, factsReviewBinding, factsReviewReducer, factsReviewStatus, MAX_REVIEWED_FACTS } from './draft-state.js'

export default function ComplaintDraft({ serviceId, serviceName, language, languageRevision, revision, busy, pending, processingMessage, onGenerate, t }) {
  const [record, setRecord] = useState(null)
  const [review, dispatchReview] = useReducer(factsReviewReducer, undefined, emptyFactsReview)
  const [error, setError] = useState('')
  const generatingRef = useRef(false)
  const aliveRef = useRef(true)
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false } }, [])
  const presentation = draftPresentation(record, { serviceId, revision })
  const differentLanguage = record && presentation.showEditor && record.language !== language
  const reviewBinding = factsReviewBinding({ serviceId, revision, language, languageRevision })
  const reviewStatus = factsReviewStatus(review, reviewBinding)
  const hasReview = Boolean(review.data)

  async function generate(fromReviewedFacts = false) {
    if (generatingRef.current || busy || (fromReviewedFacts && !reviewStatus.canSubmit)) return
    generatingRef.current = true
    setError('')
    try {
      const options = fromReviewedFacts ? { reviewedFacts: review.text, reviewContextId: review.data.context_id, factsConfirmed: true } : undefined
      const response = await onGenerate(options)
      if (!response || !aliveRef.current) return
      if (response.review_required) {
        dispatchReview({ type: 'PREPARED', data: response, binding: reviewBinding })
        return
      }
      setRecord({ text: response.draft_text, generatedText: response.draft_text, serviceId: response.service_id, serviceName, language: response.language, revision, metadata: response })
      dispatchReview({ type: 'COMPLETED' })
    } catch (failure) {
      if (aliveRef.current) {
        setError(failure.code || 'requestFailed')
        if (failure.code === 'draftReviewRequired') dispatchReview({ type: 'EXPIRED' })
      }
    } finally {
      generatingRef.current = false
    }
  }

  return <section className="complaint-draft guidance-card" aria-labelledby="draft-heading" aria-busy={pending}>
    <h2 id="draft-heading">{t.draftTitle}</h2><p className="tool-intro" id="draft-help">{t.draftIntro}</p>{!serviceId && <p className="notice">{t.draftUnresolvedDestination}</p>}
    {presentation.outdated && <p className="notice" role="status">{presentation.edited ? t.draftEditedOutdated : t.draftOutdated}{presentation.edited && record.serviceName && <> <span dir="auto">{record.serviceName}</span></>}</p>}
    {differentLanguage && <p className="notice">{t.draftLanguageNotice}</p>}
    {presentation.showEditor && <>
      <label className="field-label draft-label" htmlFor="complaint-draft">{presentation.outdated ? t.draftPreviousLabel : t.draftLabel}</label>
      <textarea id="complaint-draft" value={presentation.text} onChange={(event) => setRecord((previous) => ({ ...previous, text: event.target.value }))} disabled={pending} dir="auto" rows={14} maxLength={60000} aria-describedby="draft-help draft-review" />
      <p className="draft-review" id="draft-review">{t.draftReview}</p>
      {record.metadata.omitted_fields.length > 0 && <p className="tool-intro">{t.draftOmitted}: {record.metadata.omitted_fields.join('، ')}</p>}
      {record.metadata.warnings.length > 0 && <ul className="draft-warnings">{record.metadata.warnings.map((warning, index) => <li key={index} dir="auto">{warning}</li>)}</ul>}
    </>}
    {hasReview && <section className="facts-review" aria-labelledby="facts-review-heading">
      <h3 id="facts-review-heading">{t.factsReviewTitle}</h3><p className="tool-intro" id="facts-review-help">{t.factsReviewHelp}</p>
      {!reviewStatus.current && <p className="notice" role="status">{t.factsReviewOutdated}</p>}
      {reviewStatus.current && <details className="facts-review-references" open><summary>{t.factsReviewReferences}</summary><div className="facts-reference-content" tabIndex={0}>
        <h4>{t.factsReviewOriginal}</h4><p dir="auto">{review.data.original_text}</p>
        {review.data.updates.map((update, index) => <div className="facts-reference-update" key={index}><h4>{t.factsReviewUpdate} {index + 1}</h4>{update.question && <p className="facts-reference-question" dir="auto"><strong>{t.factsReviewQuestion}: </strong>{update.question}</p>}<p dir="auto">{update.text}</p></div>)}
        {review.data.attachment_excerpts.length > 0 && <><h4>{t.factsReviewAttachment}</h4><p>{t.factsReviewAttachmentHelp}</p><ul>{review.data.attachment_excerpts.map((excerpt, index) => <li key={index} dir="auto">{excerpt}</li>)}</ul></>}
      </div></details>}
      <label className="field-label draft-label" htmlFor="reviewed-facts">{t.factsReviewLabel}</label>
      <textarea id="reviewed-facts" value={review.text} onChange={(event) => { dispatchReview({ type: 'EDIT', text: event.target.value }); setError('') }} disabled={pending} dir="auto" rows={7} maxLength={MAX_REVIEWED_FACTS} placeholder={t.factsReviewPlaceholder} aria-describedby="facts-review-help facts-review-limit" />
      <p className="tool-intro" id="facts-review-limit">{review.text.length.toLocaleString(language)} / {MAX_REVIEWED_FACTS.toLocaleString(language)} · {t.factsReviewLocalOnly}</p>
      <label className="facts-confirmation"><input type="checkbox" checked={reviewStatus.confirmed} onChange={(event) => dispatchReview({ type: 'CONFIRM', binding: reviewBinding, confirmed: event.target.checked })} disabled={busy || !reviewStatus.current || !review.text.trim()} /><span>{t.factsReviewConfirm}</span></label>
      {record && <p className="tool-intro" id="draft-replace-help">{t.draftReplaceHelp}</p>}
      <div className="draft-actions"><button type="button" className="button secondary" onClick={() => generate(true)} disabled={busy || !reviewStatus.canSubmit} aria-describedby={record ? 'draft-replace-help' : 'facts-review-help'}>{pending ? <><span className="spinner" />{t.draftLoading}</> : t.factsReviewCreate}</button></div>
    </section>}
    {(!hasReview || !reviewStatus.current) && <>
      {!hasReview && record && <p className="tool-intro" id="draft-replace-help">{t.draftReplaceHelp}</p>}
      <div className="draft-actions"><button type="button" className="button secondary" onClick={() => generate()} disabled={busy} aria-describedby={!hasReview && record ? 'draft-replace-help' : 'draft-help'}>{pending ? <><span className="spinner" />{t.draftLoading}</> : hasReview ? t.factsReviewRefresh : record ? t.draftRegenerate : t.draftGenerate}</button></div>
    </>}
    {pending && <p className="tool-status" role="status">{processingMessage}</p>}
    {error && <p className="field-error" role="alert">{t[error] || t.requestFailed}</p>}
    {!presentation.showEditor && <p className="draft-review" id="draft-review">{t.draftReview}</p>}
  </section>
}
