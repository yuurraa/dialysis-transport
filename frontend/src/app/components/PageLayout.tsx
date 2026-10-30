import BrandMark from '../../shared/ui/BrandMark';
import type { ReactNode } from 'react';
import ThemeControl from '../../shared/ui/ThemeControl';

/** Public landing layout; authenticated dashboards have their own workspace. */
export default function PageLayout({ children, restoring = false, accountCreation = false }: { children: ReactNode; restoring?: boolean; accountCreation?: boolean }) {
  return <main className={`landing-page${restoring ? ' session-restoring' : ''}`} aria-busy={restoring}>
    <div className="landing-header"><header className="landing-brand" aria-label="OneDialysis">
      <BrandMark className="brand-symbol" />
      <span>OneDialysis</span>
    </header><ThemeControl /></div>
    <div className="landing-content">
      <section className="landing-intro" aria-labelledby="landing-title">
        <p className="journey-detail">
          <span className="journey-point" aria-hidden="true" /><span className="journey-line" aria-hidden="true" /><span className="journey-point journey-destination" aria-hidden="true" />
          <span>From your doorstep to your care.</span>
        </p>
        <h1 id="landing-title">A little closer<br />to <span>better care.</span></h1>
        <p className="landing-description">Transport to and from dialysis, with coordinated pickups and support when plans change.</p>
      </section>
      <div className="landing-entry">{children}</div>
    </div>
    <footer className="landing-footer"><span>{accountCreation ? 'Account Creation' : 'Landing Page'}</span><span>2006-SCS1-X4</span></footer>
  </main>;
}
