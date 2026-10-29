/** Shared theme-aware logo; adjacent brand text provides its accessible name. */
export default function BrandMark({ className }: { className: string }) {
  return <span className={`${className} brand-mark`} aria-hidden="true" />;
}
