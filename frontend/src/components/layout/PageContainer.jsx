export function PageContainer({ children, className = '' }) {
  return (
    <div className={`min-h-screen bg-app-bg pb-24 ${className}`}>
      <div className="max-w-md mx-auto relative">
        {children}
      </div>
    </div>
  );
}

export default PageContainer;
