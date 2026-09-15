export function PageContainer({ children, className = '' }) {
  return (
    <div className={`min-h-screen bg-app-bg pb-24 isolate ${className}`}>
      {/* Diffuse corner orbs behind the whole interface */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="orb orb-teal -top-24 -right-20 h-72 w-72" />
        <div className="orb orb-blue top-1/3 -left-28 h-80 w-80" style={{ animationDelay: '-5s' }} />
        <div className="orb orb-teal -bottom-24 right-0 h-72 w-72" style={{ animationDelay: '-9s' }} />
        <div className="orb orb-gold top-16 left-1/4 h-40 w-40" style={{ animationDelay: '-12s' }} />
      </div>

      <div className="relative z-10 max-w-md mx-auto">{children}</div>
    </div>
  );
}

export default PageContainer;
