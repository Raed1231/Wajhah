import { useEffect, useState } from 'react'
import { fetchServiceGuidance, GUIDANCE_GROUPS, REQUEST_TIMEOUT_MS, guidanceSubmissionSupport, selectChannelGuidance } from './api.js'

function GuidanceItems({ items, sources, ordered, showRequirement, t }) {
  const List = ordered ? 'ol' : 'ul'
  return <List className="guidance-items">{items.map((item) => <li key={item.id} value={ordered && Number.isInteger(item.order) ? item.order : undefined}>
    <div className="guidance-item-heading"><strong dir="auto">{item.title}</strong>{showRequirement && item.requirement_status !== 'NOT_APPLICABLE' && <span className={`requirement-label requirement-${item.requirement_status.toLowerCase()}`}>{t[`requirement${item.requirement_status}`]}</span>}</div>
    {item.description && <p dir="auto">{item.description}</p>}
    {item.conditions && <p className="guidance-context" dir="auto"><strong>{t.guidanceConditions}: </strong>{item.conditions}</p>}
    {item.scope && <p className="guidance-context" dir="auto">{item.scope}</p>}
    <div className="guidance-source-links"><span>{t.verificationVerified}</span>{item.source_ids.map((id) => {
      const source = sources.find((candidate) => candidate.id === id)
      return source?.url ? <a key={id} href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a> : null
    })}{item.url && <a href={item.url} target="_blank" rel="noopener noreferrer">{t.guidanceChannel}</a>}</div>
  </li>)}</List>
}

export default function ServiceGuidance({ serviceId, language, revision, t }) {
  const [attempt, setAttempt] = useState(0)
  const [resource, setResource] = useState(null)
  const [selection, setSelection] = useState(null)
  const resourceKey = `${serviceId}:${language}:${revision}:${attempt}`
  const current = resource?.key === resourceKey ? resource : null

  useEffect(() => {
    if (!serviceId) return undefined
    let active = true
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort('timeout'), REQUEST_TIMEOUT_MS)
    fetchServiceGuidance({ serviceId, language, signal: controller.signal }).then((data) => {
      if (active && !controller.signal.aborted) setResource({ key: resourceKey, data })
    }).catch((error) => {
      if (active) setResource({ key: resourceKey, error: controller.signal.reason === 'timeout' ? 'guidanceTimeout' : error.code || 'network' })
    }).finally(() => clearTimeout(timeout))
    return () => { active = false; clearTimeout(timeout); controller.abort('cleanup') }
  }, [serviceId, language, resourceKey])

  if (!serviceId) return null
  const data = current?.data
  const submissionSupport = data ? guidanceSubmissionSupport(data) : null
  const selected = data ? selectChannelGuidance(data, selection?.serviceId === serviceId ? selection.channelId : null) : null
  const unverified = data ? GUIDANCE_GROUPS.flatMap((group) => data.unverified_items[group]) : []
  const sourceIds = new Set(data ? GUIDANCE_GROUPS.flatMap((group) => data[group].flatMap((item) => item.source_ids)) : [])
  return <section className="service-guidance guidance-card" aria-labelledby="guidance-heading" aria-busy={!current}>
    <h2 id="guidance-heading">{t.guidanceTitle}</h2><p className="tool-intro">{t.guidanceIntro}</p>
    {!current && <p className="tool-status" role="status">{t.guidanceLoading}</p>}
    {current?.error && <div className="tool-error" role="alert"><p>{t[current.error] || t.guidanceUnavailable}</p><button className="text-button" type="button" onClick={() => setAttempt((value) => value + 1)}>{t.guidanceRetry}</button></div>}
    {data && <>
      {data.service_scope && <div className="guidance-scope"><h3>{t.guidanceServiceScope}</h3><p lang={data.service_scope_language} dir="auto">{data.service_scope}</p></div>}
      {data.reviewed_at && <p className="guidance-reviewed">{t.guidanceReviewed}: <bdi>{data.reviewed_at}</bdi></p>}
      {(data.gaps.length > 0 || unverified.length > 0) && <p className="notice">{t.guidanceGaps}</p>}
      {data.channels.length > 1 && <div className="guidance-channel-select">
        <label htmlFor="guidance-channel">{t.guidanceSelectChannel}</label>
        <select id="guidance-channel" value={selected.channel.id} onChange={(event) => setSelection({ serviceId, channelId: event.target.value })}>
          {data.channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.title}</option>)}
        </select>
      </div>}
      {selected.channel && <p className="guidance-selected-channel">{t.guidanceStepsFor}: <bdi>{selected.channel.title}</bdi></p>}
      {GUIDANCE_GROUPS.map((group) => {
        const channelGroup = group === 'prerequisites' || group === 'steps'
        const items = channelGroup ? selected[group] : data[group]
        const emptyText = channelGroup && selected.channel ? t.guidanceChannelNotDocumented : t.guidanceNotDocumented
        return <details className="guidance-section" key={group} open={group === 'steps' || group === 'documents'}>
          <summary>{t[`guidance_${group}`]}</summary>
          {items.length > 0 ? <GuidanceItems items={items} sources={data.sources} ordered={group === 'steps'} showRequirement={['prerequisites', 'information', 'documents'].includes(group)} t={t} /> : <p className="guidance-empty">{emptyText}</p>}
        </details>
      })}
      {(selected.unassignedPrerequisites.length > 0 || selected.unassignedSteps.length > 0) && <details className="guidance-section">
        <summary>{t.guidanceUnassigned}</summary>
        <p className="guidance-empty">{t.guidanceUnassignedHelp}</p>
        {selected.unassignedPrerequisites.length > 0 && <GuidanceItems items={selected.unassignedPrerequisites} sources={data.sources} showRequirement t={t} />}
        {selected.unassignedSteps.length > 0 && <GuidanceItems items={selected.unassignedSteps} sources={data.sources} ordered t={t} />}
      </details>}
      <div className="guidance-automation"><h3>{t.guidanceAutomation}</h3><p className="tool-intro">{t.guidanceRecordedStatus}: <bdi>{submissionSupport.status === 'UNKNOWN' ? t.guidanceAutomationUnknown : submissionSupport.status}</bdi> <span className="verification-label">{t[`verification${submissionSupport.verification_status}`]}</span></p><div className="guidance-source-links">{submissionSupport.sources.map((source) => <a key={source.id} href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>)}</div></div><p className="tool-intro">{t.guidanceManualOnly}</p>
      {unverified.length > 0 && <details className="guidance-section unverified-guidance"><summary>{t.guidanceUnverified}<span>{unverified.length}</span></summary><p className="guidance-empty">{t.guidanceUnverifiedHelp}</p><ul className="guidance-items">{unverified.map((item, index) => <li key={`${item.id}-${index}`}><strong dir="auto">{item.title}</strong><span className="verification-label">{t[`verification${item.verification_status}`]}</span>{item.description && <p dir="auto">{item.description}</p>}{item.conditions && <p className="guidance-context" dir="auto"><strong>{t.guidanceConditions}: </strong>{item.conditions}</p>}{item.scope && <p className="guidance-context" dir="auto">{item.scope}</p>}<div className="guidance-source-links">{item.source_ids.map((id) => { const source = data.sources.find((candidate) => candidate.id === id); return source?.url ? <a key={id} href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a> : null })}</div></li>)}</ul></details>}
      {data.gaps.length > 0 && <details className="guidance-section"><summary>{t.guidanceMissing}</summary><ul className="guidance-items">{data.gaps.map((gap, index) => <li key={gap.id || index}><strong dir="auto">{gap.title}</strong><p dir="auto">{gap.reason}</p></li>)}</ul></details>}
      {sourceIds.size > 0 && <details className="guidance-section"><summary>{t.guidanceSources}</summary><ul className="guidance-items">{data.sources.filter((source) => sourceIds.has(source.id)).map((source) => <li key={source.id}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>{source.accessed_at && <p className="guidance-context">{t.guidanceSourceDate}: <bdi>{source.accessed_at}</bdi></p>}</li>)}</ul></details>}
    </>}
  </section>
}
