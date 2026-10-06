import type { Role, ThreadItem } from './factory-thread'

const ROLE_NAME: Record<Role, string> = { joe: 'You', lead: 'Lead', planner: 'Planner', builder: 'Builder', tester: 'Tester', reviewer: 'Reviewer' }

/** Joe and the Lead in bubbles; the Planner, Builder, Tester and Reviewer post cards. Long bodies stay folded. */
export function FactoryThread({ items }: { items: ThreadItem[] }) {
  return (
    <div className="fthread">
      {items.map((it) =>
        it.role === 'joe' ? (
          <div key={it.key} className="fmsg joe" data-role="joe">
            <div className="fbubble">
              {it.text}
              {it.queued ? <p className="tiny">Queued until this step finishes.</p> : null}
            </div>
          </div>
        ) : (
          <div key={it.key} className="fmsg" data-role={it.role}>
            <span className={`who w-${it.role}`}>{ROLE_NAME[it.role][0]}</span>
            <div className="fbody">
              <div className="fname">
                {ROLE_NAME[it.role]}
                {it.meta ? <span className="fmeta">{it.meta}</span> : null}
              </div>
              {it.role === 'lead' ? (
                <p className="flead">{it.text}</p>
              ) : it.body ? (
                <details className={`fcard ${it.tone || 'info'}`} open={it.open}>
                  <summary className="fcard-title">{it.text}</summary>
                  <pre className="fcard-body">{it.body}</pre>
                </details>
              ) : (
                <div className={`fcard ${it.tone || 'info'}`}>
                  <div className="fcard-title">{it.text}</div>
                </div>
              )}
            </div>
          </div>
        )
      )}
    </div>
  )
}
